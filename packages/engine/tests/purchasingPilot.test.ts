// SIMULATED (sprint 4 B): the manual pilot rail's booking gate on every channel a pilot vendor uses.
// Real engine in live mode over the in-memory store; fake email / SMS / iMessage / phone ports record
// what would be sent; a deterministic extractor stands in for Claude. No vendor, approver or payment is real.
//   1. A vendor on the text channel confirms its booking by iMessage (or SMS): the same purchase reader
//      as email, the same identity rule (its pinned number on that deal). Before: "not_in_writing".
//   2. A confirm-only approval isn't "confirmed" until the vendor confirms in writing. Before: confirmed
//      on the human's YES alone. A vendor Haggle can't get a written answer from is refused up front.
//   3. Every quote says why it was or wasn't selected; a stale quote is never the recommendation.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain, type ExtractorPort } from "../src/index.ts";
import { vendorOwnWords } from "../src/approvals/bookingReply.ts";

const APPROVER = "+14155550101";
const TEXT_VENDOR = "+14155550177";
const PHONE_VENDOR = "+14155550188";
const T0 = Date.parse("2026-10-22T16:00:00Z");

/** Reads "$X total", "$Y deposit", "N vegetarian", "delivered by HH:MM" from the vendor's own words (email, text or call transcript). */
export const pilotExtractor: ExtractorPort = {
  async extract(i) {
    // A text reply comes with Haggle's last text for context: only the business's own words are read.
    const t = vendorOwnWords(i.bodyText.split("[The business's reply]: ").at(-1)!);
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:all[- ]in\s*)?total/i) ?? money(/total[^$\d]{0,20}\$\s?([\d,]+(?:\.\d{2})?)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const veg = t.match(/(\d+)\s*(?:vegetarian|veg\b)/i);
    const by = /deliver\w*[^.\n]{0,40}\bby (\d{1,2}:\d{2})/i.exec(t);
    const questions = t.split(/(?<=[.!?])\s+/).filter((s) => s.trim().endsWith("?")).map((text) => ({ text: text.trim(), needs_answer_to_quote: true }));
    const checks = (i.request.requirementList ?? []).map((r) => {
      if (r.kind === "dietary") return veg ? { requirement_id: r.id, met: Number(veg[1]) >= (r.min_count ?? 0), evidence: veg[0], note: `offered ${veg[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" };
      if (r.kind === "delivery") return by ? { requirement_id: r.id, met: by[1]!.padStart(5, "0") <= "11:30", evidence: by[0], note: `by ${by[1]}` } : { requirement_id: r.id, met: null, evidence: "", note: "not stated" };
      return { requirement_id: r.id, met: null, evidence: "", note: "not addressed" };
    });
    return {
      available: !/\b(can't|cannot|unable to)\b/i.test(t), price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null,
      tax_usd: null, tax_status: /tax incl|including tax|tax included/i.test(t) ? "included" : "not_mentioned", tax_rate_percent: null, tax_evidence: "", total_usd: total, deposit_usd: deposit, menu_items: [],
      dietary_coverage: veg ? [{ need: "vegetarian", covered: true, count_offered: Number(veg[1]) }] : [], valid_until: /valid until (\d{4}-\d{2}-\d{2})/i.exec(t)?.[1] ?? null, questions, payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])], missing_fields: total === null ? ["total"] : [], confidence: 0.9, requirement_checks: checks,
    } as never;
  },
};

function setup(opts: { imessage?: boolean; phone?: boolean } = {}) {
  let t = T0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string; via: "sms" | "imessage" }[] = [];
  const calls: { toNumber: string; reason: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: pilotExtractor, brain: new StubBrain(), payer: disabledPayer("off"), attachments: { load: async () => [] },
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<out_${emails.length}@ses.haggle.test>` }; } },
    sms: { async send(r) { texts.push({ ...r, via: "sms" }); return { messageId: `sms_${texts.length}` }; } },
    ...(opts.imessage ? { imessage: { async send(r) { texts.push({ ...r, via: "imessage" }); return { messageId: `im_${texts.length}` }; } } } : {}),
    ...(opts.phone ? { phone: { async placeCall(r) { calls.push(r as never); return { callId: `call_${calls.length}` }; } } } : {}),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, manualPaymentHandoff: true, callCooldownMs: 0,
    },
  });
  return { engine, repo, clock, emails, texts, calls };
}
type Env = ReturnType<typeof setup>;
let n = 0;

async function emailReply(env: Env, jobId: string, from: string, body: string) {
  const ours = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === from).at(-1)!;
  const id = ++n;
  return env.engine.ingest({
    providerEventId: `ev_${id}`, eventType: "message.received", providerEmailId: `in_${id}`, threadId: `th_${from}`, messageId: `<r${id}@mail.example>`,
    inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText: body, attachments: [], attachmentsDownloadUrl: null,
  }, (address) => ({ trusted: true, address, reason: "inkbox-same-org", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }) as never);
}
const vendorText = (env: Env, via: "sms" | "imessage", from: string, text: string) =>
  via === "imessage" ? env.engine.ingestIMessage({ messageId: `vt_${++n}`, from, text, isGroup: false }) : env.engine.ingestText({ messageId: `vt_${++n}`, from, text, inbound: true });
const approverCode = (env: Env) => /YES (\d{4})/.exec(env.texts.filter((x) => x.to === APPROVER).at(-1)!.text)![1]!;

const REQUEST = { what: "team lunch catering", quantity: 40, unit: "people", date: "2026-11-14", time: "11:30", area: "San Francisco, CA", venue: "500 Howard St", requirements: ["At least 12 vegetarian meals"] as never };

describe.each(["imessage", "sms"] as const)("a text vendor confirms its booking by %s (same reader as email)", (via) => {
  it("booking request by text; the vendor's texted CONFIRMED books it; payment instructions arrive as untrusted text", async () => {
    const env = setup({ imessage: via === "imessage" });
    const { engine, repo, clock, texts } = env;
    const deal = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Sunset Kitchen", phone: TEXT_VENDOR, channel: "imessage" }] });
    const jobId = deal.job_id;
    expect(texts.filter((x) => x.to === TEXT_VENDOR)).toHaveLength(1);
    clock.advance(5 * 60_000);
    expect((await vendorText(env, via, TEXT_VENDOR, "We can do it: $1,900 total incl tax, 14 vegetarian, delivered by 11:00, $400 deposit.")).jobId).toBe(jobId);
    clock.advance(31 * 60_000);
    await engine.advanceJob(jobId);
    const q = (await engine.getQuotes(jobId)).quotes.find((x) => x.business === "Sunset Kitchen")!;
    expect(q).toMatchObject({ total_usd: 1900, compliance: { status: "compliant" }, selection: { status: "recommended" } });

    await engine.requestApproval(jobId, q.quote_id, "imessage");
    expect((await engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${approverCode(env)}`, inbound: true })).outcome).toBe("approved");
    // Booked in writing (by text), not "not_in_writing": the vendor was asked by text, with the order's facts.
    const ask = texts.filter((x) => x.to === TEXT_VENDOR).at(-1)!;
    expect(ask.text).toMatch(/accepted your \$1,900 quote\. Reply CONFIRMED if you can do it as quoted \(\$400 deposit\), and how you take payment/);
    if (via === "sms") expect(ask.text).toMatch(/Order: team lunch catering, 40 people, Saturday, November 14, 2026 at 11:30 AM, 500 Howard St, San Francisco, CA; At least 12 vegetarian meals/);
    expect(ask.text).toMatch(/CONFIRMED/);
    expect((await repo.getBookingByApproval((await repo.getLatestApproval(jobId))!.id))!.status).toBe("awaiting_vendor_confirmation");
    expect((await engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });

    clock.advance(20 * 60_000);
    const r = await vendorText(env, via, TEXT_VENDOR, "Confirmed! For the $400 deposit, Zelle pay@sunsetkitchen.example");
    expect(r.outcome).toBe("booking_confirmed");
    const board = await engine.getQuotes(jobId);
    expect(board.purchase).toMatchObject({ stage: "instructions_received", booked: true, money_verified: false, instructions: { untrusted: true }, order: expect.stringMatching(/40 people/) });
    // A texted number can't prove who wrote payment details: SMS carries the phone-check warning; iMessage (Apple-registered handle) doesn't.
    const pay = (await repo.listEvents(jobId)).filter((e) => e.type === "payment" && e.data.status === "instructions_received").at(-1)!;
    if (via === "sms") expect(String(pay.data.warning)).toMatch(/confirm these payment details with the business by phone/);
    else expect(pay.data.warning).toBeUndefined();
    // Nothing was read as a new quote; the approval stands.
    expect((await repo.getLatestApproval(jobId))!.status).toBe("approved");
  });
});

describe("security review (workstream D): untrustworthy quotes and invalidated approvals never reach the payment handoff", () => {
  it("a simulated reply on a live deal can't be approved", async () => {
    const env = setup();
    const deal = await env.engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Harbor Table", email: "events@harbor.example" }] });
    const ours = (await env.repo.listMessages(deal.job_id)).find((m) => m.direction === "out")!;
    await env.engine.ingest({ providerEventId: "es", eventType: "message.received", providerEmailId: "in_sim", threadId: "ts", messageId: "<sim@x>", inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from: "events@harbor.example", to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText: "$2,180 total, 14 vegetarian, delivered by 11:00, $500 deposit.", attachments: [], attachmentsDownloadUrl: null },
      (address) => ({ trusted: true, address, reason: "inkbox-same-org", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }) as never, { simulated: true });
    await env.engine.advanceJob(deal.job_id);
    const q = (await env.engine.getQuotes(deal.job_id)).quotes[0]!;
    await expect(env.engine.requestApproval(deal.job_id, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_not_eligible" });
  });

  it("a cap lowered after approval: the vendor's booking yes doesn't lead to asking how to pay; the human is told not to pay", async () => {
    const env = setup();
    const { engine, repo, clock, emails, texts } = env;
    const deal = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Harbor Table", email: "events@harbor.example" }] });
    const jobId = deal.job_id;
    clock.advance(5 * 60_000);
    await emailReply(env, jobId, "events@harbor.example", "$2,180 total, 14 vegetarian, delivered by 11:00, $500 deposit.");
    clock.advance(31 * 60_000);
    await engine.advanceJob(jobId);
    const q = (await engine.getQuotes(jobId)).quotes[0]!;
    await engine.requestApproval(jobId, q.quote_id, "imessage");
    await engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${approverCode(env)}`, inbound: true });
    await engine.updateSettings({ spending_cap_cents: 30_000 }); // $300, below the approved $500 deposit
    const asked = emails.length;
    expect((await emailReply(env, jobId, "events@harbor.example", "Confirmed, all set.")).outcome).toBe("booking_confirmed");
    const events = await repo.listEvents(jobId);
    expect(events.some((e) => e.type === "payment" && e.data.status === "handoff_requested")).toBe(false);
    expect(events.some((e) => e.type === "operator_attention" && e.data.reason === "handoff_refused")).toBe(true);
    expect(emails.slice(asked).some((e) => /how you take payment|how .* pay/i.test(e.bodyText))).toBe(false);
    expect(texts.filter((x) => x.to === APPROVER).at(-1)!.text).toMatch(/no longer passes Haggle's payment checks.*Don't pay yet/);
    await expect(engine.pay(jobId, q.quote_id)).rejects.toMatchObject({ code: "handoff_refused" });
  });
});

describe("re-confirmation of a stale quote by text", () => {
  it("a text vendor's expired quote is re-confirmed by text; its texted 'confirmed' sends the approval to the human", async () => {
    const env = setup();
    const { engine, clock, texts } = env;
    const deal = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Sunset Kitchen", phone: TEXT_VENDOR, channel: "imessage" }] });
    const jobId = deal.job_id;
    clock.advance(5 * 60_000);
    await vendorText(env, "sms", TEXT_VENDOR, "$1,900 total incl tax, 14 vegetarian, delivered by 11:00, $400 deposit. Valid until 2026-10-24.");
    clock.advance(31 * 60_000);
    await engine.advanceJob(jobId);
    clock.advance(3 * 24 * 3_600_000);
    const q = (await engine.getQuotes(jobId)).quotes[0]!;
    expect(q.selection).toMatchObject({ status: "not_selectable", reason: expect.stringMatching(/^stale/) });
    const before = texts.filter((x) => x.to === APPROVER).length;
    await expect(engine.requestApproval(jobId, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_reconfirming" });
    expect(texts.filter((x) => x.to === TEXT_VENDOR).at(-1)!.text).toMatch(/does your \$1,900 quote .* still stand\? Reply "confirmed"/);
    expect(texts.filter((x) => x.to === APPROVER)).toHaveLength(before);
    clock.advance(30 * 60_000);
    expect((await vendorText(env, "sms", TEXT_VENDOR, "Confirmed, still good.")).outcome).toBe("quote_reconfirmed");
    await engine.advanceJob(jobId);
    expect(texts.filter((x) => x.to === APPROVER).at(-1)!.text).toMatch(/Approve \$400 deposit to Sunset Kitchen .*Reply YES \d{4}/);
  });
});

describe("confirm-only approvals on the manual rail need the vendor's written confirmation", () => {
  it("YES to a confirm-only approval asks the vendor; the job is confirmed only after its written yes", async () => {
    const env = setup();
    const { engine, repo, clock, emails, texts } = env;
    const deal = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Harbor Table", email: "events@harbor.example" }] });
    const jobId = deal.job_id;
    clock.advance(5 * 60_000);
    await emailReply(env, jobId, "events@harbor.example", "Happy to: $2,180 total, 14 vegetarian, delivered by 11:00. $500 deposit.");
    clock.advance(31 * 60_000);
    await engine.advanceJob(jobId);
    const q = (await engine.getQuotes(jobId)).quotes[0]!;
    await engine.requestApproval(jobId, q.quote_id, "imessage", "confirm");
    expect((await engine.ingestText({ messageId: "yes", from: APPROVER, text: `YES ${approverCode(env)}`, inbound: true })).outcome).toBe("approved");
    // Not confirmed on the human's word alone: the vendor is asked, and nothing is paid.
    expect((await repo.getJob(jobId))!.state).toBe("paying");
    expect(texts.filter((x) => x.to === APPROVER).at(-1)!.text).toMatch(/asked Harbor Table to confirm the order.*Nothing is paid through Haggle/);
    const ask = emails.at(-1)!;
    expect(ask.bodyText).toMatch(/Before anything is booked or paid, please reply to confirm/);
    expect(ask.bodyText).toMatch(/must-have: At least 12 vegetarian meals/);
    expect(ask.bodyText).not.toMatch(/how you take payment/);
    let board = await engine.getQuotes(jobId);
    expect(board.purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", confirm_only: true, amount_usd: 0 });
    await expect(engine.pay(jobId, q.quote_id)).rejects.toMatchObject({ code: "confirm_only", next: "wait_for_update" });

    // A vague reply doesn't confirm it.
    expect((await emailReply(env, jobId, "events@harbor.example", "Let me check with the kitchen and get back to you.")).outcome).toBe("booking_unclear");
    expect((await repo.getJob(jobId))!.state).toBe("paying");
    // The vendor's explicit yes completes it.
    expect((await emailReply(env, jobId, "events@harbor.example", "Confirmed, we're all set for the 14th.")).outcome).toBe("order_confirmed");
    expect((await repo.getJob(jobId))!.state).toBe("confirmed");
    board = await engine.getQuotes(jobId);
    expect(board.purchase).toMatchObject({ stage: "order_confirmed", booked: true, money_verified: false });
    expect(texts.filter((x) => x.to === APPROVER).at(-1)!.text).toMatch(/Harbor Table confirmed the order/);
    // The closing note thanks the vendor; it doesn't ask it to confirm again, and claims no payment.
    const closing = emails.at(-1)!;
    expect(closing.bodyText).toMatch(/Thanks for confirming: the order is set/);
    expect(closing.bodyText).not.toMatch(/Please reply to confirm the booking|payment of \$/);
  });

  it("a vendor Haggle reaches only by phone can't get a confirm-only approval (it could never confirm in writing)", async () => {
    const env = setup({ phone: true });
    const { engine, clock } = env;
    const deal = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Mission Eats", phone: PHONE_VENDOR, channel: "phone" }] });
    const jobId = deal.job_id;
    await engine.advanceJob(jobId);
    expect(env.calls.length).toBeGreaterThan(0);
    clock.advance(3 * 60_000);
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "local: Hi, I'm an AI assistant calling on behalf of a customer.\nremote: We can do $1,700 total all-in, 14 vegetarian, delivered by 11:00, with a $300 deposit." });
    clock.advance(31 * 60_000);
    await engine.advanceJob(jobId);
    const q = (await engine.getQuotes(jobId)).quotes[0]!;
    expect(q.total_usd).toBe(1700);
    await expect(engine.requestApproval(jobId, q.quote_id, "imessage", "confirm")).rejects.toMatchObject({ code: "confirm_needs_written_reply" });
    // A paying approval still works: the human confirms with them directly (not_in_writing), as before.
    await engine.requestApproval(jobId, q.quote_id, "imessage", "pay");
  });
});

describe("selection reasons and stale quotes", () => {
  it("every quote says why it was or wasn't selected; the cheaper noncompliant one never wins; a stale quote is never recommended", async () => {
    const env = setup();
    const { engine, clock } = env;
    const deal = await engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Harbor Table", email: "events@harbor.example" }, { name: "Golden Grill", email: "grill@golden.example" }] });
    const jobId = deal.job_id;
    clock.advance(5 * 60_000);
    await emailReply(env, jobId, "events@harbor.example", "$2,180 total, 14 vegetarian, delivered by 11:00, $500 deposit. Quote valid until 2026-10-25.");
    await emailReply(env, jobId, "grill@golden.example", "$1,650 total, only 6 vegetarian, delivered by 11:00.");
    clock.advance(31 * 60_000);
    await engine.advanceJob(jobId);
    let board = await engine.getQuotes(jobId);
    const by = (name: string) => board.quotes.find((x) => x.business === name)!;
    expect(by("Harbor Table").selection).toEqual({ status: "recommended", reason: expect.stringMatching(/^recommended: meets every requirement/) });
    expect(by("Golden Grill").selection).toMatchObject({ status: "selectable", reason: expect.stringMatching(/misses a must: doesn't meet: At least 12 vegetarian meals/) });
    expect(board.recommended_quote_id).toBe(by("Harbor Table").quote_id);
    // Four days later Harbor's quote is past its valid-until date: no longer the recommendation, and it says why.
    clock.advance(4 * 24 * 3_600_000);
    board = await engine.getQuotes(jobId);
    expect(by("Harbor Table").selection).toMatchObject({ status: "not_selectable", reason: expect.stringMatching(/^stale: past its valid-until date \(2026-10-25\)/) });
    expect(board.recommended_quote_id).toBeUndefined();
  });
});
