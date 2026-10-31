// External email regressions (HAGGLE_EXTERNAL_SENDERS=reply_token; no token is sent since
// 2026-10-30): spoofing, forwards, replies across jobs and businesses, mismatched references,
// duplicate delivery, new emails matched by sender; and operator-facing quarantine explanations.
// Real engine, in-memory store, fake ports; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type ExtractorPort } from "../src/index.ts";
import { EXPLAINED_QUARANTINE_REASONS, explainQuarantine } from "../src/inbound/quarantineReasons.ts";
import type { TrustVerdict } from "../src/inbound/types.ts";

const A = "orders@realcaterer.example";
const B = "hello@othercaterer.example";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const noEvidence = { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] };
const external = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: noEvidence });
const dmarcFail = (): TrustVerdict => ({ trusted: false, retryable: false, reason: "unverified-external-sender", evidence: { ...noEvidence, dmarc: "fail", dmarcFromDomain: "realcaterer.example" } });

const extractor: ExtractorPort = {
  async extract(i) {
    const m = i.bodyText.match(/\$\s?([\d,]+)\s*total/i);
    const total = m ? Number(m[1]!.replace(/,/g, "")) : null;
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true, total_usd: total, deposit_usd: null,
      menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
      sources: total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : [], missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

function setup() {
  const emails: { to: string; subject: string; bodyText: string; messageId: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { const messageId = `<0100019A${emails.length + 1}@email.amazonses.com>`; emails.push({ ...m, messageId }); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, externalSenders: "reply_token" },
  });
  return { engine, repo, emails };
}
type Env = ReturnType<typeof setup>;

async function twoVendorDeal(env: Env) {
  const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Real Caterer", email: A }, { name: "Other Caterer", email: B }] });
  const bs = await env.repo.getBusinesses(deal.job_id);
  const biz = (email: string) => bs.find((b) => b.email === email)!;
  // This deal's RFQ to that vendor (each deal's RFQ has its own Message-ID).
  const rfq = (email: string) => env.emails.find((e) => e.messageId === biz(email).rfq_message_id)!;
  return { jobId: deal.job_id, biz, rfq };
}

let seq = 0;
function mail(env: Env, o: { from: string; inReplyTo: string[]; subject: string; bodyText: string; references?: string[]; id?: string }, trust: () => TrustVerdict = external) {
  const k = ++seq;
  return env.engine.ingest({
    providerEventId: `ev${k}`, eventType: "message.received", providerEmailId: o.id ?? `in_${k}`, threadId: `th${k}`, messageId: `<r${k}@mail.example>`,
    inReplyTo: o.inReplyTo, references: o.references ?? o.inReplyTo, from: o.from, to: ["haggle@inkboxmail.test"], subject: o.subject, bodyText: o.bodyText, attachments: [], attachmentsDownloadUrl: null,
  }, trust);
}
const quotes = async (env: Env, jobId: string) => { await env.engine.advanceJob(jobId); return (await env.engine.getQuotes(jobId)).quotes; };
const quarantined = async (env: Env, jobId: string) => (await env.repo.listMessages(jobId)).filter((m) => m.kind === "quarantine").map((m) => m.quarantine_reason);

describe("external email regressions", () => {
  it("no code goes out; a reply naming Haggle's Message-ID from the pinned address is a quote (continuity), a DMARC failure never", async () => {
    const env = setup();
    const { jobId, rfq } = await twoVendorDeal(env);
    expect(rfq(A).subject).toMatch(/^Quote request: /);
    expect(`${rfq(A).subject}${rfq(A).bodyText}`).not.toMatch(/HGR-|\[HG-/);
    expect((await mail(env, { from: A, inReplyTo: [rfq(A).messageId], subject: "Re: Quote request", bodyText: "Updated: $1 total." }, dmarcFail)).outcome).toBe("quarantined:identity_unverified");
    expect(await quarantined(env, jobId)).toEqual(["identity_unverified:auth_failed"]);
    expect((await mail(env, { from: A, inReplyTo: [rfq(A).messageId], subject: "Re: Quote request", bodyText: "$1,150 total" })).outcome).toBe("stored");
    expect((await quotes(env, jobId)).map((q) => q.total_usd)).toEqual([1150]);
  });

  it("across businesses: B's thread from A's address is a sender mismatch; A in its own thread works", async () => {
    const env = setup();
    const { jobId, rfq } = await twoVendorDeal(env);
    expect((await mail(env, { from: A, inReplyTo: [rfq(B).messageId], subject: "Re: Quote request", bodyText: "$6 total" })).outcome).toMatch(/^quarantined:sender_mismatch/);
    expect(await quotes(env, jobId)).toHaveLength(0);
    expect((await mail(env, { from: A, inReplyTo: [rfq(A).messageId], subject: "Re: Quote request", bodyText: "$1,150 total" })).outcome).toBe("stored");
    expect((await quotes(env, jobId)).map((q) => q.total_usd)).toEqual([1150]);
  });

  it("across jobs: a reply in the first deal's thread is read into the first deal only", async () => {
    const env = setup();
    const first = await twoVendorDeal(env);
    const second = await twoVendorDeal(env);
    expect(first.rfq(A).messageId).not.toBe(second.rfq(A).messageId);
    expect((await mail(env, { from: A, inReplyTo: [first.rfq(A).messageId], subject: "Re: Quote request", bodyText: "$7 total" })).outcome).toBe("stored");
    expect((await quotes(env, first.jobId)).map((q) => q.total_usd)).toEqual([7]);
    expect(await quotes(env, second.jobId)).toHaveLength(0);
  });

  it("mismatched references: In-Reply-To names no message of ours, References names another business's; neither verifies A", async () => {
    const env = setup();
    const { jobId, rfq } = await twoVendorDeal(env);
    await twoVendorDeal(env); // A is on two open deals: a new email from A can't be attributed by sender
    expect((await mail(env, { from: A, inReplyTo: ["<forged@email.amazonses.com>"], references: ["<forged@email.amazonses.com>"], subject: "Re: Quote request", bodyText: "$8 total" })).outcome).toBe("quarantined:ambiguous_sender");
    expect((await mail(env, { from: A, inReplyTo: ["<forged2@x>"], references: [rfq(B).messageId], subject: "Re: Quote request", bodyText: "$9 total" })).outcome).toMatch(/^quarantined:sender_mismatch/);
    expect(await quotes(env, jobId)).toHaveLength(0);
  });

  it("a fresh email (not a reply) from the pinned address: one open deal -> a sender-only quote; an old [HG-code] tag picks the deal among several", async () => {
    const env = setup();
    const { jobId } = await twoVendorDeal(env);
    expect((await mail(env, { from: A, inReplyTo: [], subject: "our quote", bodyText: "$10 total" })).outcome).toBe("stored");
    expect((await env.repo.listMessages(jobId)).find((m) => m.direction === "in")).toMatchObject({ sender_trusted: true, trust_reason: "external-sender-only", matched_via: "sender_only" });
    const second = await twoVendorDeal(env);
    const job2 = (await env.repo.getJob(second.jobId))!;
    expect((await mail(env, { from: A, inReplyTo: [], subject: "another quote", bodyText: "$11 total" })).outcome).toBe("quarantined:ambiguous_sender");
    expect((await mail(env, { from: A, inReplyTo: [], subject: `[HG-${job2.short_code}] our quote`, bodyText: "$12 total" })).outcome).toBe("stored");
    expect((await env.repo.listMessages(second.jobId)).find((m) => m.direction === "in")).toMatchObject({ trust_reason: "external-sender-only", matched_via: "subject_tag" });
  });

  it("a forward replied from another address is quarantined; forwarded as a new message from a stranger, it matches nothing", async () => {
    const env = setup();
    const { jobId, rfq } = await twoVendorDeal(env);
    const fwd = `$11 total.\n\n---------- Forwarded message ---------\nFrom: Haggle <haggle@inkboxmail.test>\nSubject: ${rfq(A).subject}\n\n${rfq(A).bodyText}`;
    expect((await mail(env, { from: "colleague@gmail.example", inReplyTo: [rfq(A).messageId], subject: `Fwd: ${rfq(A).subject}`, bodyText: fwd })).outcome).toMatch(/^quarantined:sender_mismatch/);
    expect((await mail(env, { from: "colleague@gmail.example", inReplyTo: [], subject: `Fwd: ${rfq(A).subject}`, bodyText: fwd })).outcome).toBe("quarantined:no_signal");
    expect(await quotes(env, jobId)).toHaveLength(0);
  });

  it("duplicate delivery (webhook + sweep) of a quarantined message stores it once and flags it once", async () => {
    const env = setup();
    const { jobId, rfq } = await twoVendorDeal(env);
    const spoof = { from: "attacker@gmail.example", inReplyTo: [rfq(A).messageId], subject: "Re: Quote request", bodyText: "$1 total", id: "in_dup" };
    expect((await mail(env, spoof)).outcome).toBe("quarantined:sender_mismatch");
    expect((await mail(env, spoof)).outcome).toBe("duplicate");
    const failed = { from: A, inReplyTo: [rfq(A).messageId], subject: "Re: Quote request", bodyText: "$2 total", id: "in_dup2" };
    expect((await mail(env, failed, dmarcFail)).outcome).toBe("quarantined:identity_unverified");
    expect((await mail(env, failed, dmarcFail)).outcome).toBe("duplicate");
    const flags = (await env.repo.listEvents(jobId)).filter((e) => e.type === "flag" && e.data.flag === "unverified_sender");
    expect(flags).toHaveLength(2);
  });
});

describe("quarantine reasons operators can act on", () => {
  const ENGINE_REASONS = [
    "identity_unverified:token_missing", "identity_unverified:not_in_our_thread", "identity_unverified:from_mismatch", "identity_unverified:auth_failed",
    "sender_mismatch", "from_unparseable", "unknown_job_inbox", "no_signal", "ambiguous_sender", "bounce", "bounce_soft", "bounce_unmatched", "pay_not_from_approver", "paid_not_from_approver",
  ];
  it("every reason the engine records has a specific explanation, an action, and a short board line", () => {
    for (const r of ENGINE_REASONS) {
      const e = explainQuarantine(r);
      expect(e.known, r).toBe(true);
      expect(EXPLAINED_QUARANTINE_REASONS).toContain(r);
      expect(e.explanation.length, r).toBeGreaterThan(20);
      expect(e.action.length, r).toBeGreaterThan(10);
      expect(e.board.length, r).toBeLessThanOrEqual(100);
    }
    expect(explainQuarantine("something_new")).toMatchObject({ known: false, reason: "something_new" });
  });

  it("the deal board's business line and the job event say what happened and what to do", async () => {
    const env = setup();
    const { jobId, rfq } = await twoVendorDeal(env);
    await mail(env, { from: A, inReplyTo: [rfq(A).messageId], subject: "Re: Quote request", bodyText: "$1,150 total" }, dmarcFail);
    await mail(env, { from: "colleague@gmail.example", inReplyTo: [rfq(B).messageId], subject: "Re: Quote request", bodyText: "$900 total" });
    const board = await env.engine.getQuotes(jobId);
    expect(board.businesses.find((b) => b.name === "Real Caterer")!.last_event).toBe(explainQuarantine("identity_unverified:auth_failed").board);
    expect(board.businesses.find((b) => b.name === "Other Caterer")!.last_event).toBe(explainQuarantine("sender_mismatch").board);
    const ev = (await env.repo.listEvents(jobId)).find((e) => e.type === "flag" && e.data.quarantine_reason === "identity_unverified:auth_failed")!;
    expect(ev.data).toMatchObject({ explanation: expect.stringMatching(/authentication/), action: expect.stringMatching(/Ignore it/), message_id: expect.any(String) });
    expect(String(ev.data.summary)).toMatch(/Ignore it/);
  });
});
