// Opt-out and bounce recognition hardened against false positives and spoofing (WS-F findings):
// a newsletter "unsubscribe" footer isn't an opt-out; an unverified STOP stops only this job; a
// bounce needs a DSN sender or an enhanced status code, and "$550" is not SMTP 550. Plus the
// keyword-fallback reader's partial "can't" and European number format. Fakes only; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type ExtractorPort } from "../src/index.ts";
import { isOptOut, parseBounce, replyToken } from "../src/inbound/senderAuth.ts";
import { heuristicExtract } from "../src/parsing/heuristic.ts";
import { findDollarAmounts } from "../src/parsing/callSafety.ts";
import type { TrustVerdict } from "../src/inbound/primitive.ts";

const SECRET = "test-reply-token-secret-0123456789";
const V = "orders@realcaterer.example";
const W = "hello@competitor.example";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });

const extractor: ExtractorPort = {
  async extract(i) {
    const m = i.bodyText.match(/total:?\s*\$\s?([\d,]+)/i);
    const total = m ? Number(m[1]!.replace(/,/g, "")) : null;
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: total, deposit_usd: null,
      menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: total !== null ? [{ field: "total" as const, source: "email body", excerpt: `Total $${total}` }] : [], missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

function setup() {
  const emails: { to: string; subject: string; messageId: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { const messageId = `<em_${emails.length + 1}@email.amazonses.com>`; emails.push({ ...m, messageId }); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, externalSenders: "reply_token", replyTokenSecret: SECRET },
  });
  return { engine, repo, emails };
}
type Env = ReturnType<typeof setup>;
async function deal(env: Env, emails = [V, W]) {
  const d = await env.engine.deal({ request, budget_usd, businesses: emails.map((e, i) => ({ name: `Vendor ${i}`, email: e })) });
  const b = (await env.repo.getBusinesses(d.job_id)).find((x) => x.email === V)!;
  const job = (await env.repo.getJob(d.job_id))!;
  return { jobId: d.job_id, b, job, token: replyToken(SECRET, d.job_id, b.business_id) };
}
let n = 0;
const mail = (env: Env, o: { from?: string; subject: string; bodyText: string; inReplyTo?: string[] }) => {
  const k = ++n;
  return env.engine.ingest({ providerEventId: `e${k}`, eventType: "message.received", providerEmailId: `in_${k}`, threadId: `t${k}`, messageId: `<r${k}@x>`, inReplyTo: o.inReplyTo ?? [], references: o.inReplyTo ?? [], from: o.from ?? V, to: ["haggle@inkboxmail.test"], subject: o.subject, bodyText: o.bodyText, attachments: [], attachmentsDownloadUrl: null }, external);
};

describe("isOptOut: only the business's own request, never a footer", () => {
  it("newsletter/marketing footers and unsubscribe links are not opt-outs", () => {
    for (const t of [
      "Total: $1,045 delivered, tax included. 12 vegetarian.\nThanks!\n--\nHarbor Table | 415-555-0100\nNewsletter: reply UNSUBSCRIBE to stop marketing mail",
      "Total: $1,045.\nTo unsubscribe from our mailing list click here: https://x.example/u",
      "Total $900. Thanks\nSent from my iPhone\nUnsubscribe",
      "Our quote: Total $1,100. (Manage preferences or unsubscribe at www.example.com/prefs)",
    ]) expect(isOptOut(t), t).toBe(false);
  });
  it("still recognises real requests", () => {
    for (const t of ["STOP", "Unsubscribe", "unsubscribe me please", "Please unsubscribe us.", "Please remove me from your list.", "Don't contact us again.", "Do not email me."]) expect(isOptOut(t), t).toBe(true);
  });
});

describe("parseBounce: a DSN, not a vendor's words", () => {
  it("a subject alone from a vendor is not a bounce; '$550' is not SMTP 550", () => {
    expect(parseBounce({ from: V, subject: "Re: Quote request (resending: mail delivery failed)", bodyText: "Total: $1,150. Deposit: $550", inReplyTo: ["<em_1@x>"], references: [] })).toBeNull();
    expect(parseBounce({ from: "mailer-daemon@x.example", subject: "Undeliverable", bodyText: "Your deposit of $550 and 550.00 and 5,550", inReplyTo: [], references: [] })).toMatchObject({ hard: false });
    expect(parseBounce({ from: "mailer-daemon@x.example", subject: "Undeliverable", bodyText: "550 user unknown", inReplyTo: [], references: [] })).toMatchObject({ hard: true });
    expect(parseBounce({ from: "it@relay.example", subject: "Undeliverable: Quote request", bodyText: "Remote server returned 550 5.1.1 RESOLVER.ADR.RecipNotFound", inReplyTo: [], references: [] })).toMatchObject({ hard: true });
  });
  it("end to end: the vendor's 'resending' reply with a $550 deposit is stored as a quote, nobody is suppressed", async () => {
    const env = setup();
    const { jobId, b, token } = await deal(env, [V]);
    const r = await mail(env, { subject: `Re: Quote request (resending: mail delivery failed) ${token}`, bodyText: "Resending since our first reply bounced. Total: $1,150 delivered. Deposit: $550 5.1.1", inReplyTo: [b.rfq_message_id!] });
    expect(r.outcome).toBe("stored");
    expect(await env.repo.findSuppressions([V])).toEqual([]);
    await env.engine.advanceJob(jobId);
    expect((await env.engine.getQuotes(jobId)).quotes.map((q) => q.total_usd)).toEqual([1150]);
  });
});

describe("opt-outs: unverified stops this job only; verified suppresses everywhere", () => {
  it("a competitor spoofing the vendor's From with STOP (it knows the job code) stops this job only", async () => {
    const env = setup();
    const { jobId, job, b } = await deal(env);
    expect((await mail(env, { subject: `Re: [HG-${job.short_code}] Quote request`, bodyText: "STOP" })).outcome).toBe("opted_out");
    expect((await env.repo.getBusinesses(jobId)).find((x) => x.business_id === b.business_id)!.status).toBe("declined");
    expect(await env.repo.findSuppressions([V])).toEqual([]);
    expect((await env.repo.listEvents(jobId)).some((e) => e.data.opt_out === "opt_out_unverified")).toBe(true);
    await expect(env.engine.deal({ request, budget_usd, businesses: [{ name: "Vendor 0", email: V }] })).resolves.toBeTruthy();
  });
  it("a verified STOP (reply token, our thread) suppresses the address for every deal", async () => {
    const env = setup();
    const { b, token } = await deal(env);
    expect((await mail(env, { subject: `Re: Quote request (ref ${token})`, bodyText: "Please remove us from your list.", inReplyTo: [b.rfq_message_id!] })).outcome).toBe("opted_out");
    expect(await env.repo.findSuppressions([V])).toEqual([expect.objectContaining({ reason: "opt_out" })]);
    await expect(env.engine.deal({ request, budget_usd, businesses: [{ name: "Vendor 0", email: V }] })).rejects.toBeTruthy();
  });
  it("a quote with a newsletter footer is read as a quote", async () => {
    const env = setup();
    const { jobId, b, token } = await deal(env, [V]);
    expect((await mail(env, { subject: `Re: ${token}`, bodyText: "Total: $1,045 delivered.\n--\nNewsletter: reply UNSUBSCRIBE to stop marketing mail", inReplyTo: [b.rfq_message_id!] })).outcome).toBe("stored");
    expect(await env.repo.findSuppressions([V])).toEqual([]);
  });
});

describe("keyword fallback reader", () => {
  const req = { what: "lunch", location: "SF", dietary: [], requirements: [] } as never;
  it("a partial 'can't' with a total is a quote, not a decline", () => {
    expect(heuristicExtract({ request: req, bodyText: "We can't do nut-free, but everything else is fine. Total: $1,100" }).available).toBe(true);
    expect(heuristicExtract({ request: req, bodyText: "Sorry, we can't do that date." }).available).toBe(false);
  });
  it("'1.150,00 USD' is never read as $0", () => {
    expect(findDollarAmounts("Total: 1.150,00 USD")).not.toContain(0);
    expect(findDollarAmounts("Total: 1150 USD")).toEqual([115000]);
  });
});
