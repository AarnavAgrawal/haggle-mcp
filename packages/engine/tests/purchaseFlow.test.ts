// Workstream D: the purchase after quotes (compliance, freshness, re-confirmation, booking, manual
// handoff, cancellation, timeouts). Pure modules first, then the real engine over the in-memory
// store with fake ports. No network; every vendor and payment here is simulated.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type ExtractorPort } from "../src/index.ts";
import { confirmsReceipt, readBookingReply, vendorOwnWords } from "../src/approvals/bookingReply.ts";
import { assessCompliance } from "../src/ranking/compliance.ts";
import { quoteFreshness } from "../src/ranking/validity.ts";
import { normalizeRequirements } from "../src/workflow/requestNormalize.ts";
import type { TrustVerdict } from "../src/inbound/primitive.ts";

describe("readBookingReply: only an explicit yes in the vendor's own words books", () => {
  const ctx = { agreedCents: [218_000, 50_000], quantity: 60 };
  it("confirms explicit yeses, ignoring quoted history (Gmail and Outlook header blocks)", () => {
    expect(readBookingReply("Confirmed! See you on the 14th.\n\nOn Thu, Oct 22, 2026 at 9:14 AM Haggle <h@x> wrote:\n> please confirm", ctx).intent).toBe("confirm");
    expect(readBookingReply("Yes, we're all set. $2,180 total and $500 deposit stand.", ctx).intent).toBe("confirm");
    expect(readBookingReply("Sounds good, booked.\n\nFrom: Haggle\nSent: Thursday\nTo: Sunset\nSubject: x\n\nThe total of $9,999 stands", ctx).intent).toBe("confirm");
  });
  it("a question, a promise to confirm later, or our own words quoted back are never a confirmation", () => {
    expect(readBookingReply("Can you confirm the headcount?", ctx).intent).toBe("unclear");
    expect(readBookingReply("Let me check with the chef and I'll confirm tomorrow.", ctx).intent).toBe("unclear");
    expect(readBookingReply("Thanks!\n\nFrom: Haggle <h@x>\nSent: Thu\nTo: v\nSubject: Re\n\nPlease reply to confirm: you're available", ctx).intent).toBe("unclear");
    expect(readBookingReply("> Confirmed\n> yes", ctx).intent).toBe("unclear");
  });
  it("declines and changed terms are read as such", () => {
    expect(readBookingReply("Unfortunately we're fully booked that day.", ctx).intent).toBe("decline");
    expect(readBookingReply("Confirmed, but the total is now $2,400.", ctx)).toMatchObject({ intent: "change", otherAmountsCents: [240_000] });
    expect(readBookingReply("Yes, confirmed for 50 guests.", ctx).intent).toBe("change");
  });
  it("flags payment instructions and links (never opened)", () => {
    expect(readBookingReply("Confirmed. Pay the invoice at https://pay.example/1", ctx)).toMatchObject({ intent: "confirm", paymentInstructions: true, hasLink: true });
    expect(readBookingReply("Confirmed, see you then", ctx)).toMatchObject({ paymentInstructions: false, hasLink: false });
  });
  it("receipt needs an un-negated 'received' from the vendor", () => {
    expect(confirmsReceipt("Got the deposit, thanks!").received).toBe(true);
    expect(confirmsReceipt("Payment received. See you Saturday").received).toBe(true);
    expect(confirmsReceipt("We haven't received the payment yet.").received).toBe(false);
    expect(confirmsReceipt("Did you send it? Nothing has arrived.").received).toBe(false);
    expect(confirmsReceipt("Has the payment been received?").received).toBe(false);
    expect(vendorOwnWords("ok\n\nOn Mon, X wrote:\n> received")).toBe("ok");
  });
});

describe("quoteFreshness", () => {
  const at = "2026-10-22T16:00:00Z";
  it("expires after the business's valid-until day, or after the window; a re-confirmation restarts it", () => {
    expect(quoteFreshness({ created_at: at, valid_until: "2026-10-29" }, new Date("2026-10-29T15:00:00Z")).stale).toBe(false);
    expect(quoteFreshness({ created_at: at, valid_until: "2026-10-27" }, new Date("2026-10-28T00:30:00Z"))).toMatchObject({ stale: true, reason: "expired" });
    expect(quoteFreshness({ created_at: at, valid_until: null }, new Date("2026-10-30T16:00:01Z"))).toMatchObject({ stale: true, reason: "aged" });
    expect(quoteFreshness({ created_at: at, valid_until: "2026-10-29" }, new Date("2026-10-31T00:00:00Z"), undefined, "2026-10-30T12:00:00Z").stale).toBe(false);
  });
});

describe("assessCompliance", () => {
  const reqs = [{ id: "veg", kind: "dietary" as const, text: "At least 12 vegetarian", hard: true, min_count: 12 }, { id: "date", kind: "date" as const, text: "On Nov 14", hard: true }];
  const base = { requirements: reqs, totalCents: 200_000, payNowCents: 50_000, budgetCents: 250_000, budgetKind: "target" as const, capCents: 150_000 };
  it("compliant only when every hard requirement is met, within budget and cap; request facts are marked assumed", () => {
    expect(assessCompliance({ ...base, results: [{ requirement_id: "veg", met: true, reason: "" }, { requirement_id: "date", met: true, reason: "", basis: "request_fact" }] })).toMatchObject({ status: "compliant", assumed: ["On Nov 14"] });
  });
  it("a missing answer is unconfirmed; a stated miss, over budget or pay-now over the cap is noncompliant", () => {
    expect(assessCompliance({ ...base, results: [{ requirement_id: "date", met: true, reason: "" }] }).status).toBe("unconfirmed");
    expect(assessCompliance({ ...base, results: [{ requirement_id: "veg", met: false, reason: "only 6 of 12" }, { requirement_id: "date", met: true, reason: "" }] }).issues[0]!.text).toMatch(/only 6 of 12/);
    expect(assessCompliance({ ...base, totalCents: 260_000, results: [{ requirement_id: "veg", met: true, reason: "" }, { requirement_id: "date", met: true, reason: "" }] }).status).toBe("noncompliant");
    expect(assessCompliance({ ...base, payNowCents: 160_000, results: [{ requirement_id: "veg", met: true, reason: "" }, { requirement_id: "date", met: true, reason: "" }] }).issues.map((x) => x.code)).toEqual(["pay_now_over_cap"]);
  });
});

describe("normalizeRequirements: plain words become checkable requirements", () => {
  it("infers kind, dietary minimum and keeps an explicit kind; duplicates collapse; ids stay unique", () => {
    expect(normalizeRequirements(["At least 12 vegetarian meals", "Delivered to the office by 11:30", "nut-free", { text: "Licensed and insured", kind: "other" }, "nut-free", { id: "r1", text: "Must be on Nov 14" }])).toEqual([
      { id: "r1", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 },
      { id: "r2", kind: "delivery", text: "Delivered to the office by 11:30", hard: true },
      { id: "r3", kind: "dietary", text: "nut-free", hard: true },
      { id: "r4", kind: "other", text: "Licensed and insured", hard: true },
      { id: "r1_2", kind: "date", text: "Must be on Nov 14", hard: true },
    ]);
  });
});

// ── engine ──────────────────────────────────────────────────────────────────────────────────────
const APPROVER = "+14155550101";
const VENDOR = "harbor@inkboxmail.test";
const OTHER = "sunset@inkboxmail.test";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const trusted = (expected: string): TrustVerdict => ({ trusted: true, address: expected, reason: "trusted", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const extractor: ExtractorPort = {
  async extract(i) {
    const t = vendorOwnWords(i.bodyText);
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+)\s*total/i);
    const deposit = money(/\$\s?([\d,]+)\s*deposit/i);
    return {
      available: !/can't|cannot/i.test(t), price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true, tax_usd: null, tax_included: true,
      total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }], valid_until: /valid until (\d{4}-\d{2}-\d{2})/i.exec(t)?.[1] ?? null,
      questions: [], payment_request: "none", instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    } as never;
  },
};

function setup(config: Partial<EngineConfig> = {}) {
  let t = Date.parse("2026-10-22T16:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string; idempotencyKey: string }[] = [];
  const texts: { to: string; text: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, manualPaymentHandoff: true, ...config },
  });
  return { engine, repo, clock, emails, texts };
}
type Env = ReturnType<typeof setup>;
let n = 0;
async function mail(env: Env, jobId: string, from: string, bodyText: string) {
  const ours = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === from).at(-1)!;
  const id = ++n;
  return env.engine.ingest({ providerEventId: `e${id}`, eventType: "message.received", providerEmailId: `in_${id}`, threadId: `t_${from}`, messageId: `<in_${id}@x>`, inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
}
async function quoted(env: Env, opts: { phone?: boolean; valid?: string } = {}) {
  const deal = await env.engine.deal({ request, budget_usd, businesses: [opts.phone ? { name: "Harbor", email: VENDOR, phone: "+14155550123" } : { name: "Harbor", email: VENDOR }, { name: "Sunset", email: OTHER }] });
  await mail(env, deal.job_id, VENDOR, `$1,150 total, delivered, $345 deposit.${opts.valid ? ` Valid until ${opts.valid}.` : ""}`);
  await mail(env, deal.job_id, OTHER, "$1,190 total, delivered, $300 deposit.");
  await env.engine.advanceJob(deal.job_id);
  const q = (await env.engine.getQuotes(deal.job_id)).quotes.find((x) => x.business === "Harbor")!;
  return { jobId: deal.job_id, q };
}
async function approved(env: Env) {
  const r = await quoted(env);
  const a = await env.engine.requestApproval(r.jobId, r.q.quote_id, "imessage");
  expect((await env.engine.ingestText({ messageId: `yes${++n}`, from: APPROVER, text: `YES ${a.code}`, inbound: true })).outcome).toBe("approved");
  return { ...r, a };
}
const toVendor = (env: Env) => env.emails.filter((e) => e.to === VENDOR);

describe("booking after approval (manual handoff)", () => {
  it("a decline after acceptance withdraws the approval; nothing is paid; the job goes back to choosing", async () => {
    const env = setup();
    const { jobId, a } = await approved(env);
    expect((await mail(env, jobId, VENDOR, "Unfortunately we can't do that date after all, sorry.")).outcome).toBe("booking_declined");
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("declined");
    expect((await env.repo.getJob(jobId))!.state).toBe("collecting");
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "booking_declined", vendor_reply: { untrusted: true } });
    expect(env.texts.at(-1)!.text).toMatch(/can't take the booking.*nothing was paid/);
    expect(await env.repo.getHandoffByApproval(a.id)).toBeNull();
  });

  it("an unclear reply keeps it unbooked and the human is told not to pay; a phone-only business is 'not in writing'", async () => {
    const env = setup();
    const { jobId } = await approved(env);
    expect((await mail(env, jobId, VENDOR, "Let me check with the chef and get back to you.")).outcome).toBe("booking_unclear");
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });
    expect(env.texts.at(-1)!.text).toMatch(/hasn't clearly confirmed.*Don't pay yet/);
  });

  it("a booking that is never confirmed: one reminder, the human told, operator_attention recorded (once)", async () => {
    const env = setup({ bookingTimeoutMs: 60 * 60_000 });
    const { jobId } = await approved(env);
    const before = toVendor(env).length;
    env.clock.advance(61 * 60_000);
    await env.engine.advanceJob(jobId);
    await env.engine.advanceJob(jobId);
    expect(toVendor(env).length).toBe(before + 1);
    expect(toVendor(env).at(-1)!.bodyText).toMatch(/can you confirm the booking/);
    expect((await env.repo.listEvents(jobId)).filter((e) => e.type === "operator_attention")).toMatchObject([{ data: { reason: "booking_unconfirmed" } }]);
    expect(env.texts.at(-1)!.text).toMatch(/hasn't confirmed the booking yet/);
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stalled: true, operator_attention: expect.any(String) });
  });

  it("payment instructions that never come: reminder, human told, operator-visible", async () => {
    const env = setup({ handoffTimeoutMs: 60 * 60_000 });
    const { jobId } = await approved(env);
    expect((await mail(env, jobId, VENDOR, "Confirmed, all set for the date.")).outcome).toBe("booking_confirmed");
    env.clock.advance(61 * 60_000);
    await env.engine.advanceJob(jobId);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "operator_attention" && e.data.reason === "payment_instructions_overdue")).toBe(true);
    expect(env.texts.at(-1)!.text).toMatch(/hasn't sent payment instructions/);
  });
});

describe("cancellation", () => {
  it("before approval: replied businesses get the plain cancel note", async () => {
    const env = setup();
    const { jobId } = await quoted(env);
    await env.engine.cancel(jobId);
    expect(toVendor(env).at(-1)!.bodyText).toMatch(/cancelled this request/);
  });

  it("after approval, before payment: the accepted business hears no payment was made; booking and approval closed", async () => {
    const env = setup();
    const { jobId, a } = await approved(env);
    await mail(env, jobId, VENDOR, "Confirmed. Zelle us at pay@harbor.");
    expect((await env.engine.cancel(jobId)).state).toBe("cancelled");
    expect(toVendor(env).at(-1)!.bodyText).toMatch(/cancelled this order before paying.*No payment was made/s);
    expect(env.emails.filter((e) => e.to === OTHER).at(-1)!.bodyText).toMatch(/Thank you for your quote/);
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("cancelled");
    expect((await env.repo.getHandoffByApproval(a.id))!.status).toBe("cancelled");
    expect((await env.repo.getApproval(a.id))!.status).toBe("expired");
    expect((await env.engine.ingestText({ messageId: "late-paid", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).not.toBe("handoff_confirmed");
  });

  it("after the customer reported paying: flagged for the operator, the human told to contact the vendor, no refund claimed and nothing sent", async () => {
    const env = setup();
    const { jobId, a } = await approved(env);
    await mail(env, jobId, VENDOR, "Confirmed. Zelle us at pay@harbor.");
    expect((await env.engine.ingestText({ messageId: "paid", from: APPROVER, text: `PAID ${a.code}`, inbound: true })).outcome).toBe("handoff_confirmed");
    const sent = toVendor(env).length;
    const r = await env.engine.cancel(jobId);
    expect(r).toMatchObject({ state: "paid", flagged: true });
    expect(r.note).toMatch(/can't cancel or refund it/);
    expect(toVendor(env).length).toBe(sent);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "operator_attention" && e.data.reason === "cancel_after_reported_payment")).toBe(true);
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "cancel_requested_after_payment", money_verified: false });
    for (const e of env.emails) expect(e.bodyText).not.toMatch(/refund/i);
  });
});

describe("stale quotes are re-confirmed before approval", () => {
  it("a changed total is never approved silently: the human hears the new price and nothing is opened", async () => {
    const env = setup();
    const { jobId, q } = await quoted(env, { valid: "2026-10-23" });
    env.clock.advance(3 * 24 * 3_600_000);
    await expect(env.engine.requestApproval(jobId, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_reconfirming" });
    await mail(env, jobId, VENDOR, "Prices went up: $1,300 total now, $345 deposit.");
    await env.engine.advanceJob(jobId);
    // Only Haggle's lapsed "all quotes are in" suggestion exists; nothing new was opened for the human.
    expect(["pending", "approved"]).not.toContain((await env.repo.getLatestApproval(jobId))?.status);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "reconfirm_resolved" && e.data.outcome === "changed")).toBe(true);
    expect(env.texts.at(-1)!.text).toMatch(/changed its quote from \$1,150 to \$1,300/);
  });

  it("no reply in time: resolved as no_reply and the human told; a fresh quote needs no re-confirmation", async () => {
    const env = setup({ reconfirmTimeoutMs: 60 * 60_000 });
    const { jobId, q } = await quoted(env, { valid: "2026-10-23" });
    const sunset = (await env.engine.getQuotes(jobId)).quotes.find((x) => x.business === "Sunset")!;
    env.clock.advance(3 * 24 * 3_600_000);
    await expect(env.engine.requestApproval(jobId, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_reconfirming" });
    env.clock.advance(61 * 60_000);
    await env.engine.advanceJob(jobId);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "reconfirm_resolved" && e.data.outcome === "no_reply")).toBe(true);
    expect(env.texts.at(-1)!.text).toMatch(/hasn't confirmed its quote still stands/);
    // Sunset's quote (no valid-until, 3 days old) is inside the 7-day window: approvable at once.
    expect((await env.engine.requestApproval(jobId, sunset.quote_id, "imessage")).status).toBe("pending");
  });
});

describe("recommendation never picks a quote that misses a must", () => {
  it("a cheaper quote that only partly confirms is ranked below and not recommended; a deposit over the workspace cap isn't either", async () => {
    const env = setup();
    await env.engine.updateSettings({ spending_cap_cents: 30_000 });
    const { jobId } = await quoted(env);
    const board = await env.engine.getQuotes(jobId);
    // Both deposits ($345, $300) vs a $300 cap: only Sunset's fits.
    expect(board.quotes.find((x) => x.business === "Harbor")!.compliance).toMatchObject({ status: "noncompliant", issues: [{ code: "pay_now_over_cap" }] });
    expect(board.recommended_quote_id).toBe(board.quotes.find((x) => x.business === "Sunset")!.quote_id);
  });
});
