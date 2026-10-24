// Production pass 2 (2026-10-21), toward a real-vendor pilot: replies from real mailboxes (Gmail,
// Outlook) without trusting a From address or a thread alone; one advancing instance per job
// (leases) and claimed outbound actions (outbox); an honest manual payment handoff; revalidation
// whenever a payment or handoff resumes; opt-outs, bounces and per-workspace vendor authorization.
// Adversarial throughout. Real engine, in-memory store, fake ports; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type ExtractorPort } from "../src/index.ts";
import { simulatedStripe, type StripePort } from "../src/payments/stripe.ts";
import { isOptOut, parseBounce, replyToken } from "../src/inbound/senderAuth.ts";
import { PostgresRepository } from "../src/store/postgres.ts";
import type { TrustVerdict } from "../src/inbound/primitive.ts";
import { verifyApprover } from "./helpers/verifiedApprover.ts";

const APPROVER = "+14155550101";
const SECRET = "test-reply-token-secret-0123456789";
const VENDOR = "orders@realcaterer.example";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
/** What Inkbox says about any mail from outside Inkbox: it can't authenticate it. */
const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });
const trusted = (expected: string): TrustVerdict => ({ trusted: true, address: expected, reason: "trusted", evidence: noEvidence });

const textExtractor: ExtractorPort = {
  async extract(i) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*total/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

function setup(config: Partial<EngineConfig> = {}, opts: { repo?: InMemoryRepository | PostgresRepository; stripe?: StripePort; extractor?: ExtractorPort } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string; idempotencyKey: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = (opts.repo ?? new InMemoryRepository({ now: clock.now })) as InMemoryRepository;
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: opts.extractor ?? textExtractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    ...(opts.stripe ? { stripe: opts.stripe } : {}),
    email: { async send(m) { emails.push(m); return { providerId: `em_${m.idempotencyKey}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}_${m.idempotencyKey.replace(/\W/g, "")}@haggle.test>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, ...config,
    },
  });
  return { engine, repo, clock, emails, texts };
}

type Env = ReturnType<typeof setup>;

async function dealWith(env: Env, email = VENDOR) {
  const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email }] });
  const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
  return { jobId: deal.job_id, b };
}

/** An inbound email, by default a well-formed reply in the RFQ's thread. */
function mail(env: Env, b: { rfq_message_id: string | null }, n: number, over: Partial<Parameters<HaggleEngine["ingest"]>[0]> = {}, trust: (e: string) => TrustVerdict = external) {
  const rfq = b.rfq_message_id!;
  return env.engine.ingest({ providerEventId: `ev${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `th${n}`, messageId: `<in_${n}@realcaterer.example>`, inReplyTo: [rfq], references: [rfq], from: VENDOR, to: ["haggle@inkboxmail.test"], subject: "Re: Quote request", bodyText: "We can do it: $1,150 total, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null, ...over }, trust);
}

describe("real external email (Gmail/Outlook) is accepted only with proof beyond From and thread", () => {
  const cfg = { externalSenders: "reply_token" as const, replyTokenSecret: SECRET };

  it("every email to the business carries its reply token; a reply that keeps it, from the pinned address, in our thread, becomes a quote", async () => {
    const env = setup(cfg);
    const { jobId, b } = await dealWith(env);
    const token = replyToken(SECRET, jobId, b.business_id);
    expect(env.emails[0]!.subject).toContain(token);
    expect(env.emails[0]!.bodyText).toContain(token);
    expect((await mail(env, b, 1, { subject: env.emails[0]!.subject.replace(/^/, "Re: ") })).outcome).toBe("stored");
    await env.engine.advanceJob(jobId);
    const q = (await env.engine.getQuotes(jobId)).quotes.find((x) => x.business === "Real Caterer")!;
    expect(q.total_usd).toBe(1150);
    const m = (await env.repo.listMessages(jobId)).find((x) => x.direction === "in")!;
    expect(m).toMatchObject({ sender_trusted: true, trust_reason: "external-reply-token" });
  });

  it("a forged reply with the right From and thread but no token is quarantined, never a quote", async () => {
    const env = setup(cfg);
    const { jobId, b } = await dealWith(env);
    expect((await mail(env, b, 2, { subject: "Re: Quote request", bodyText: "Updated: $1 total. $1 deposit." })).outcome).toBe("quarantined:identity_unverified");
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes).toHaveLength(0);
  });

  it("a wrong or guessed token, or the token outside our thread, is quarantined", async () => {
    const env = setup(cfg);
    const { jobId, b } = await dealWith(env);
    const token = replyToken(SECRET, jobId, b.business_id);
    expect((await mail(env, b, 3, { subject: "Re: ref HGR-AAAAAAAAAA" })).outcome).toBe("quarantined:identity_unverified");
    // The token without In-Reply-To/References to Haggle's own message (a new thread naming the job code).
    const job = (await env.repo.getJob(jobId))!;
    expect((await mail(env, b, 4, { inReplyTo: [], references: [], threadId: "new", subject: `[HG-${job.short_code}] ${token}` })).outcome).toBe("quarantined:identity_unverified");
    // The token from another address is a sender mismatch.
    expect((await mail(env, b, 5, { from: "attacker@gmail.example", subject: `Re: ${token}` })).outcome).toMatch(/^quarantined/);
  });

  it("explicit authentication failure evidence overrides the token", async () => {
    const env = setup(cfg);
    const { jobId, b } = await dealWith(env);
    const token = replyToken(SECRET, jobId, b.business_id);
    const dmarcFail = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: { ...noEvidence, dmarc: "fail", dmarcFromDomain: "realcaterer.example" } });
    expect((await mail(env, b, 6, { subject: `Re: ${token}` }, dmarcFail)).outcome).toBe("quarantined:identity_unverified");
  });

  it("off by default, and refuses to start without a secret", async () => {
    const env = setup();
    const { jobId, b } = await dealWith(env);
    expect(env.emails[0]!.subject).not.toMatch(/HGR-/);
    await mail(env, b, 7);
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes).toHaveLength(0);
    expect(() => setup({ externalSenders: "reply_token" })).toThrow(/replyTokenSecret/);
  });
});

describe("job leases: one advancing instance per job, across processes", () => {
  it("two instances advancing the same job concurrently read the reply once", async () => {
    const repo = new InMemoryRepository();
    let reads = 0;
    const slow: ExtractorPort = { async extract(i) { reads++; await new Promise((r) => setTimeout(r, 30)); return textExtractor.extract(i); } };
    const a = setup({ instanceId: "a" }, { repo, extractor: slow });
    const b = setup({ instanceId: "b" }, { repo, extractor: slow });
    const { jobId, b: biz } = await dealWith(a, "harbor@inkboxmail.test");
    await mail(a, biz, 8, { from: "harbor@inkboxmail.test" }, trusted);
    await Promise.all([a.engine.advanceJob(jobId), b.engine.advanceJob(jobId)]);
    expect(reads).toBe(1);
    expect((await repo.listEvents(jobId)).filter((e) => e.type === "quote")).toHaveLength(1);
  });

  it("a lease left by a crashed instance expires; another instance then advances the job", async () => {
    const repo = new InMemoryRepository();
    const a = setup({ instanceId: "a" }, { repo });
    const b = setup({ instanceId: "b" }, { repo });
    const { jobId, b: biz } = await dealWith(a, "harbor@inkboxmail.test");
    expect(await repo.acquireJobLease(jobId, "crashed", a.clock.now().toISOString(), 60_000)).toBe(true);
    await mail(a, biz, 9, { from: "harbor@inkboxmail.test" }, trusted);
    await b.engine.advanceJob(jobId);
    expect((await b.engine.getQuotes(jobId)).quotes).toHaveLength(0); // held by the crashed instance
    b.clock.advance(5 * 60_000);
    await b.engine.advanceJob(jobId);
    expect((await b.engine.getQuotes(jobId)).quotes).toHaveLength(1);
  });
});

describe("outbox: every outbound action is claimed before the provider is called", () => {
  it("an email claimed by another instance moments ago is not sent again; a stale claim (crash) is resent under the same provider key", async () => {
    const env = setup();
    const { jobId, b } = await dealWith(env, "harbor@inkboxmail.test");
    const key = `test-followup:${jobId}`;
    await env.repo.claimOutbox({ key, job_id: jobId, kind: "email" }, env.clock.now().toISOString());
    const job = (await env.repo.getJob(jobId))!;
    const sendRecorded = (env.engine as unknown as { sendRecorded: (j: unknown, b: unknown, k: string, key: string, m: unknown) => Promise<unknown> }).sendRecorded.bind(env.engine);
    const before = env.emails.length;
    await expect(sendRecorded(job, b, "followup", key, { to: b.email, subject: "x", bodyText: "y" })).rejects.toMatchObject({ name: "ChannelSendError", retryable: true });
    expect(env.emails.length).toBe(before);
    env.clock.advance(3 * 60_000);
    await sendRecorded(job, b, "followup", key, { to: b.email, subject: "x", bodyText: "y" });
    expect(env.emails.slice(before).map((e) => e.idempotencyKey)).toEqual([key]);
    expect((await env.repo.getOutbox(key))!.status).toBe("sent");
  });

  it("a call claimed once is never claimed again, even by the database's own rules", async () => {
    const repo = new InMemoryRepository();
    const now = new Date().toISOString();
    await repo.claimOutbox({ key: "call:x", job_id: null, kind: "call" }, now);
    expect(await repo.reclaimOutbox("call:x", ["pending", "unknown"], now)).toBeNull();
    await repo.finishOutbox("call:x", "unknown", null, now);
    expect(await repo.reclaimOutbox("call:x", ["unknown"], now)).toBeNull();
  });
});

describe("manual payment handoff: honest, human-completed", () => {
  const manual = { manualPaymentHandoff: true };

  async function approved(env: Env) {
    const { jobId, b } = await dealWith(env, "harbor@inkboxmail.test");
    await mail(env, b, 10, { from: "harbor@inkboxmail.test" }, trusted);
    await env.engine.advanceJob(jobId);
    const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
    const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
    expect(await env.engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
    return { jobId, b, q, a };
  }
  const vendorMail = (env: Env) => env.emails.filter((e) => e.to === "harbor@inkboxmail.test");

  /** The business confirms the booking (availability and the approved terms) in its own words. */
  async function booked(env: Env) {
    const r = await approved(env);
    expect((await mail(env, r.b, 20, { from: "harbor@inkboxmail.test", bodyText: "Confirmed, we're all set for your event. See you then!" }, trusted)).outcome).toBe("booking_confirmed");
    return r;
  }

  it("approval first asks the business to confirm the booking; nothing says payment was sent; pay never charges", async () => {
    const env = setup(manual);
    const { jobId, q } = await approved(env);
    const ask = vendorMail(env).at(-1)!;
    expect(ask.bodyText).toMatch(/please reply to confirm/i);
    expect(ask.bodyText).toMatch(/Nothing has been paid yet/);
    expect(vendorMail(env).some((e) => /has been sent|payment sent|we've paid|paid you/i.test(e.bodyText))).toBe(false);
    // The human is told not to pay before the business confirms.
    expect(env.texts.at(-1)!.text).toMatch(/don't pay yet/i);
    const p = await env.engine.pay(jobId, q.quote_id);
    expect(p).toMatchObject({ rail: "manual", status: "awaiting_vendor_confirmation" });
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
  });

  it("once booked, the business is asked how it takes payment; its instructions are untrusted text (links never followed, never parsed as a quote); only the approver's PAID <code> completes it", async () => {
    const env = setup(manual);
    const { jobId, b, q, a } = await booked(env);
    expect(vendorMail(env).at(-1)!.bodyText).toMatch(/how you take payment/i);
    await mail(env, b, 11, { from: "harbor@inkboxmail.test", bodyText: "Pay here: https://pay.evil.example/x or Zelle orders@harbor." }, trusted);
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes.find((x) => x.quote_id === q.quote_id)).toBeTruthy();
    expect((await env.repo.listEvents(jobId)).filter((e) => e.type === "quote")).toHaveLength(1); // not read as a revision
    const h = (await env.repo.getHandoffByApproval(a.id))!;
    expect(h).toMatchObject({ status: "instructions_received" });
    expect(h.instructions_text).toContain("pay.evil.example");
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "instructions_received", instructions: { untrusted: true, has_link: true } });
    // The agent's pay can't complete it; a PAID from any other number is ignored.
    await env.engine.pay(jobId, q.quote_id);
    expect((await env.engine.ingestText({ messageId: "p1", from: "+14155550666", text: `PAID ${a.code}`, inbound: true })).outcome).toBe("paid_ignored_not_approver");
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
    expect(await env.engine.ingestText({ messageId: "p2", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).toMatchObject({ outcome: "handoff_confirmed" });
    expect((await env.repo.getJob(jobId))!.state).toBe("paid");
    expect((await env.repo.getHandoffByApproval(a.id))!).toMatchObject({ status: "human_confirmed", confirmed_by: APPROVER });
    const done = vendorMail(env).at(-1)!;
    expect(done.bodyText).toMatch(/the customer (has )?(told us|confirmed|reports) (they|that they) (have )?paid/i);
    expect(done.bodyText).not.toMatch(/has been sent/i);
    // Reported, not verified: never "settled".
    expect((await env.engine.getQuotes(jobId)).payment).toMatchObject({ status: "human_reported_paid", rail: "manual" });
    expect((await env.engine.ingestText({ messageId: "p3", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_already_confirmed");
  });

  it("a different total in the business's reply after booking withdraws the approval: nothing is paid, and the new terms need a new approval", async () => {
    const env = setup(manual);
    const { jobId, b, a } = await booked(env);
    await mail(env, b, 12, { from: "harbor@inkboxmail.test", bodyText: "Pay here: https://pay.evil.example/x. Actually it's $9,999 total now." }, trusted);
    await env.engine.advanceJob(jobId);
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect((await env.repo.getHandoffByApproval(a.id))!.status).toBe("cancelled");
    expect((await env.repo.getJob(jobId))!.state).not.toBe("paying");
    expect(env.texts.some((t) => /approval was withdrawn; nothing was paid/.test(t.text))).toBe(true);
    expect((await env.engine.ingestText({ messageId: "p9", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).not.toBe("handoff_confirmed");
  });

  it("a resumed handoff is revalidated: a cap lowered below the amount refuses the confirmation and tells nobody it was paid", async () => {
    const env = setup(manual);
    const { jobId, a } = await booked(env);
    await env.engine.updateSettings({ spending_cap_cents: 10_000 });
    const sent = vendorMail(env).length;
    expect((await env.engine.ingestText({ messageId: "p4", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_refused");
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
    expect(vendorMail(env).length).toBe(sent);
  });
});

describe("a resumed Stripe charge is revalidated", () => {
  it("a stale `charging` row isn't sent to Stripe again once the workspace cap no longer allows it", async () => {
    let charges = 0;
    const base = simulatedStripe();
    const stripe: StripePort = { ...base, async charge(i: never) { charges++; return (base as unknown as { charge: (i: never) => Promise<unknown> }).charge(i); } } as never;
    const env = setup({}, { stripe });
    const { jobId, b } = await dealWith(env, "harbor@inkboxmail.test");
    await mail(env, b, 12, { from: "harbor@inkboxmail.test" }, trusted);
    await env.engine.advanceJob(jobId);
    const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
    const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
    await env.engine.ingestText({ messageId: "yes2", from: APPROVER, text: `YES ${a.code}`, inbound: true });
    // A crash right after the payment row was written: `charging`, never sent to Stripe.
    await env.repo.touchJob(jobId, { pay_intent: true });
    await env.repo.insertPayment({ id: "pay_crash", job_id: jobId, approval_id: a.id, business_id: q.business_id, status: "charging", rail: "stripe", amount_cents: a.payment_cents, amount_base_units: String(a.payment_cents), network: "stripe-test", idempotency_key: `haggle-pay-${a.id}`, stripe_payment_intent_id: null, challenge_json: null, challenge_step_id: null, challenge_message_id: null, challenge_trusted: false, challenge_thread_matched: false, pay_to: null, interaction_json: null, settle_tx: null, simulated: true, reason: null } as never);
    await env.engine.updateSettings({ spending_cap_cents: 10_000 });
    env.clock.advance(2 * 60_000);
    await env.engine.advanceJob(jobId);
    expect(charges).toBe(0);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "payment_refused" && e.data.code === "OVER_SPEND_CAP")).toBe(true);
  });
});

describe("opt-outs, bounces and per-workspace vendor authorization", () => {
  it("recognises real opt-outs and hard bounces, not ordinary replies", () => {
    for (const t of ["STOP", "unsubscribe", "Please remove me from your list.", "Don't contact us again.", "please stop emailing us", "Opt me out", "Do not email me."]) expect(isOptOut(t), t).toBe(true);
    for (const t of ["Please don't contact us before Monday, we're closed.", "We can stop by at noon.", "Remove the dessert and it's $1,100 total.", "We can't opt out of the delivery fee.", "Call us anytime", "", "Sounds good!\n\nOn Tue, Haggle wrote:\n> reply STOP to opt out"]) expect(isOptOut(t), t).toBe(false);
    expect(parseBounce({ from: "mailer-daemon@x.example", subject: "Undeliverable", bodyText: "550 5.1.1 user unknown <m1@haggle.test>", inReplyTo: [], references: [] })).toMatchObject({ hard: true, messageIds: ["<m1@haggle.test>"] });
    expect(parseBounce({ from: "mailer-daemon@x.example", subject: "Delayed", bodyText: "451 4.4.1 temporarily deferred", inReplyTo: [], references: [] })).toMatchObject({ hard: false });
    expect(parseBounce({ from: "orders@caterer.example", subject: "Re: quote", bodyText: "$1,150 total", inReplyTo: [], references: [] })).toBeNull();
  });

  it("a business that asks to stop is never contacted again, by this deal or any other", async () => {
    const env = setup();
    const { jobId, b } = await dealWith(env, "harbor@inkboxmail.test");
    expect((await mail(env, b, 13, { from: "harbor@inkboxmail.test", bodyText: "Please remove me from your list. Unsubscribe." }, trusted)).outcome).toBe("opted_out");
    expect((await env.repo.findSuppressions(["harbor@inkboxmail.test"]))[0]).toMatchObject({ reason: "opt_out" });
    expect((await env.repo.getBusinesses(jobId))[0]!.status).toBe("declined");
    const sent = env.emails.length;
    const again = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Harbor", email: "harbor@inkboxmail.test" }, { name: "Other", email: "other@inkboxmail.test" }] });
    expect(again.not_contacted.map((x) => x.business)).toContain("Harbor");
    expect(env.emails.slice(sent).map((e) => e.to)).toEqual(["other@inkboxmail.test"]);
  });

  it("a hard bounce naming Haggle's own message suppresses the address; a forged bounce without it is ignored", async () => {
    const env = setup();
    const { jobId, b } = await dealWith(env, "harbor@inkboxmail.test");
    const forged = await env.engine.ingest({ providerEventId: "bx", eventType: "message.received", providerEmailId: "in_bx", threadId: null, messageId: "<bx@x>", inReplyTo: [], references: [], from: "mailer-daemon@googlemail.example", to: ["haggle@inkboxmail.test"], subject: "Delivery Status Notification (Failure)", bodyText: "550 5.1.1 harbor@inkboxmail.test does not exist", attachments: [], attachmentsDownloadUrl: null }, external);
    expect(forged.outcome).not.toBe("bounced");
    expect(await env.repo.findSuppressions(["harbor@inkboxmail.test"])).toHaveLength(0);
    const dsn = await env.engine.ingest({ providerEventId: "bo", eventType: "message.received", providerEmailId: "in_bo", threadId: null, messageId: "<bo@x>", inReplyTo: [], references: [], from: "mailer-daemon@googlemail.example", to: ["haggle@inkboxmail.test"], subject: "Delivery Status Notification (Failure)", bodyText: `Your message wasn't delivered to harbor@inkboxmail.test.\n550 5.1.1 The email account does not exist.\nMessage-ID: ${b.rfq_message_id}`, attachments: [], attachmentsDownloadUrl: null }, external);
    expect(dsn).toMatchObject({ jobId, outcome: "bounced" });
    expect((await env.repo.getBusinesses(jobId))[0]!.status).toBe("bounced");
    expect((await env.repo.findSuppressions(["harbor@inkboxmail.test"]))[0]).toMatchObject({ reason: "bounce" });
  });

  it("STOP from a texted business's number suppresses it", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Text Shop", phone: "+14155550177", channel: "imessage" }] });
    expect(env.texts.some((x) => x.to === "+14155550177")).toBe(true);
    expect((await env.engine.ingestText({ messageId: "stop1", from: "+14155550177", text: "STOP", inbound: true })).outcome).toBe("opted_out");
    expect((await env.repo.findSuppressions(["+14155550177"]))[0]).toMatchObject({ reason: "opt_out", job_id: deal.job_id });
  });

  it("a vendor authorized for one workspace can't be contacted from another; the agent can't authorize vendors", async () => {
    const env = setup({ recipientAllowlist: [] });
    for (const id of ["ws_alpha", "ws_beta"]) await env.repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await env.engine.addWorkspaceVendor({ workspace_id: "ws_alpha", contact: VENDOR, name: "Real Caterer", consent: "Owner agreed by phone 2026-10-20 to receive quote requests", added_by: "operator" });
    await env.engine.updateSettings({ approver_phone: "+14155550131" }, "ws_alpha", "operator");
    await verifyApprover(env.repo, "ws_alpha", "+14155550131");
    const alpha = env.engine.forWorkspace("ws_alpha");
    const beta = env.engine.forWorkspace("ws_beta");
    await expect(alpha.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email: VENDOR }] })).resolves.toMatchObject({ ok: true });
    await expect(beta.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email: VENDOR }] })).rejects.toMatchObject({ code: "recipient_not_allowed" });
    expect(alpha.canContact({ email: VENDOR })).toBe(false); // the sync check is server-wide only
    expect(await alpha.mayContact({ email: VENDOR })).toBe(true);
    expect(await beta.mayContact({ email: VENDOR })).toBe(false);
    expect("addWorkspaceVendor" in alpha).toBe(false);
  });
});

// The same guarantees on Postgres, with migrations 100-106 and their triggers: two repositories
// (two connection pools) stand in for two server processes. Run by scripts/test-postgres.sh.
const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("pilot safety on Postgres (two instances)", { timeout: 60_000 }, () => {
  const uniq = () => Math.random().toString(36).slice(2, 8);

  it("job leases: two processes advancing one job read the reply once", async () => {
    const [p1, p2] = [new PostgresRepository(PG_URL!), new PostgresRepository(PG_URL!)];
    try {
      let reads = 0;
      const slow: ExtractorPort = { async extract(i) { reads++; await new Promise((r) => setTimeout(r, 50)); return textExtractor.extract(i); } };
      const a = setup({ instanceId: "pg_a" }, { repo: p1, extractor: slow });
      const b = setup({ instanceId: "pg_b" }, { repo: p2, extractor: slow });
      const addr = `harbor-${uniq()}@inkboxmail.test`;
      const { jobId, b: biz } = await dealWith(a, addr);
      await mail(a, biz, Number.parseInt(uniq(), 36), { from: addr, providerEmailId: `in_${uniq()}` }, trusted);
      await Promise.all([a.engine.advanceJob(jobId), b.engine.advanceJob(jobId)]);
      expect(reads).toBe(1);
      expect((await p1.listEvents(jobId)).filter((e) => e.type === "quote")).toHaveLength(1);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });

  it("outbox: concurrent claims of one action give exactly one sender; a claimed call is never re-claimed", async () => {
    const [p1, p2] = [new PostgresRepository(PG_URL!), new PostgresRepository(PG_URL!)];
    try {
      const key = `email:${uniq()}`;
      const now = new Date().toISOString();
      const claims = await Promise.all([p1, p2, p1, p2, p1].map((r) => r.claimOutbox({ key, job_id: null, kind: "email" }, now)));
      expect(claims.filter((c) => c.fresh)).toHaveLength(1);
      const call = `call:${uniq()}`;
      await p1.claimOutbox({ key: call, job_id: null, kind: "call" }, now);
      await p1.finishOutbox(call, "unknown", null, now);
      expect(await p2.reclaimOutbox(call, ["unknown", "pending"], now)).toBeNull();
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });

  it("manual handoff end to end under the database's triggers; opt-out suppression is shared", async () => {
    const pg = new PostgresRepository(PG_URL!);
    try {
      const env = setup({ manualPaymentHandoff: true }, { repo: pg });
      const addr = `harbor-${uniq()}@inkboxmail.test`;
      const { jobId, b } = await dealWith(env, addr);
      await mail(env, b, 1, { from: addr, providerEmailId: `in_${uniq()}` }, trusted);
      await env.engine.advanceJob(jobId);
      const q = (await env.engine.getQuotes(jobId)).quotes[0]!;
      const a = await env.engine.requestApproval(jobId, q.quote_id, "imessage");
      await env.engine.ingestText({ messageId: `y_${uniq()}`, from: APPROVER, text: `YES ${a.code}`, inbound: true });
      expect(await env.engine.pay(jobId, q.quote_id)).toMatchObject({ rail: "manual", status: "awaiting_vendor_confirmation" });
      // PAID before the business confirmed the booking records nothing (the 110 trigger refuses a handoff too).
      expect((await env.engine.ingestText({ messageId: `p0_${uniq()}`, from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("paid_before_booking");
      await mail(env, b, 3, { from: addr, providerEmailId: `in_${uniq()}`, bodyText: "Yes, confirmed for that date. We take Zelle at orders@harbor." }, trusted);
      expect(await env.engine.pay(jobId, q.quote_id)).toMatchObject({ rail: "manual", status: "instructions_received" });
      expect((await env.engine.ingestText({ messageId: `p_${uniq()}`, from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_confirmed");
      expect((await pg.getJob(jobId))!.state).toBe("paid");
      expect(env.emails.filter((e) => e.to === addr).some((e) => /has been sent/i.test(e.bodyText))).toBe(false);
      expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "human_reported_paid", amount_usd: 345, money_verified: false });
      // The business's own "received" (verified sender) is stored under 110's trigger: settled_verified.
      expect((await mail(env, b, 4, { from: addr, providerEmailId: `in_${uniq()}`, bodyText: "Payment received, thank you!" }, trusted)).outcome).toBe("receipt_confirmed");
      expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "settled_verified", money_verified: true });
      // Opt-out recorded on Postgres stops a later deal from another engine.
      const other = `stop-${uniq()}@inkboxmail.test`;
      const d2 = await dealWith(env, other);
      await mail(env, d2.b, 2, { from: other, providerEmailId: `in_${uniq()}`, bodyText: "Unsubscribe" }, trusted);
      const env2 = setup({}, { repo: pg });
      await expect(env2.engine.deal({ request, budget_usd, businesses: [{ name: "Stopped", email: other }] })).rejects.toMatchObject({ code: "recipient_suppressed" });
    } finally {
      await pg.close();
    }
  });
});

