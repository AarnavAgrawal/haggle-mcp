// SIMULATED (post-sprint-5 decisions H1–H3, approved by Yash 2026-10-22). Real engine in live mode over
// the in-memory store; fake email / SMS / iMessage / phone ports record what would be sent; a
// deterministic extractor stands in for Claude. No vendor, approver or payment is real.
//   H2: a vendor's texted "confirmed" never books on its own (the approver's BOOKED <code> does), and a
//       texted "received" never marks money received. Before: an SMS/iMessage from the vendor's number
//       booked the deal and recorded settled_verified.
//   H1: an inbound call matched by caller ID is not callback consent. Before: `called_us` from caller ID.
//   H3: cancelling a vendor-confirmed booking needs the approver's CANCEL <code>; the model's cancel_deal
//       only asks for it. Before: cancel_deal cancelled it outright.
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKSPACE_ID, disabledPayer, HaggleEngine, InMemoryRepository, StubBrain, WorkspaceEngine } from "../src/index.ts";
import { callbackConsent } from "../src/workflow/callbackAuth.ts";
import { bindingTermsTrust, provesSenderIdentity } from "../src/inbound/trustStrength.ts";
import { pilotExtractor } from "./helpers/pilotExtractor.ts";

const APPROVER = "+14155550101";
const TEXT_VENDOR = "+14155550177";
const PHONE_VENDOR = "+14155550188";
const T0 = Date.parse("2026-10-22T16:00:00Z");

function setup(opts: { imessage?: boolean; phone?: boolean; trustInboundCallerId?: boolean } = {}) {
  let t = T0;
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string; via: "sms" | "imessage" }[] = [];
  const calls: { toNumber: string; reason: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: pilotExtractor, brain: new StubBrain(), payer: disabledPayer("off"), attachments: { load: async () => [] },
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<out_${emails.length}@ses.haggle.test>` }; } },
    sms: { async send(r) { texts.push({ ...r, via: "sms" }); return { messageId: `dsms_${texts.length}` }; } },
    ...(opts.imessage ? { imessage: { async send(r) { texts.push({ ...r, via: "imessage" }); return { messageId: `dim_${texts.length}` }; } } } : {}),
    ...(opts.phone ? { phone: { async placeCall(r) { calls.push(r as never); return { callId: `call_${calls.length}` }; } } } : {}),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 1, notifyPhone: APPROVER, manualPaymentHandoff: true, callCooldownMs: 0,
      ...(opts.trustInboundCallerId ? { trustInboundCallerId: true } : {}),
    },
  });
  return { engine, repo, clock, emails, texts, calls, w: new WorkspaceEngine(engine, DEFAULT_WORKSPACE_ID) };
}
type Env = ReturnType<typeof setup>;
let n = 0;

async function emailReply(env: Env, jobId: string, from: string, body: string) {
  const ours = (await env.repo.listMessages(jobId)).filter((m) => m.direction === "out" && m.to_address === from).at(-1)!;
  const id = ++n;
  return env.engine.ingest({
    providerEventId: `dev_${id}`, eventType: "message.received", providerEmailId: `din_${id}`, threadId: `th_${from}`, messageId: `<d${id}@mail.example>`,
    inReplyTo: [ours.rfc_message_id!], references: [ours.rfc_message_id!], from, to: ["haggle@inkboxmail.test"], subject: `Re: ${ours.subject}`, bodyText: body, attachments: [], attachmentsDownloadUrl: null,
  }, (address) => ({ trusted: true, address, reason: "inkbox-same-org", evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } }) as never);
}
const vendorText = (env: Env, via: "sms" | "imessage", from: string, text: string) =>
  via === "imessage" ? env.engine.ingestIMessage({ messageId: `dvt_${++n}`, from, text, isGroup: false }) : env.engine.ingestText({ messageId: `dvt_${++n}`, from, text, inbound: true });
const approverText = (env: Env, text: string) => env.engine.ingestText({ messageId: `dap_${++n}`, from: APPROVER, text, inbound: true });
const lastToApprover = (env: Env) => env.texts.filter((x) => x.to === APPROVER).at(-1)!.text;
const approverCode = (env: Env) => /YES (\d{4})/.exec(lastToApprover(env))![1]!;

const REQUEST = { what: "team lunch catering", quantity: 40, unit: "people", date: "2026-11-14", time: "11:30", area: "San Francisco, CA", venue: "500 Howard St", requirements: ["At least 12 vegetarian meals"] as never };

/** A text vendor quotes; the human approves it by coded text; Haggle asks the vendor to confirm the booking. */
async function approvedTextDeal(env: Env, via: "sms" | "imessage") {
  const deal = await env.engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Sunset Kitchen", phone: TEXT_VENDOR, channel: "imessage" }] });
  env.clock.advance(5 * 60_000);
  await vendorText(env, via, TEXT_VENDOR, "We can do it: $1,900 total incl tax, 14 vegetarian, delivered by 11:00, $400 deposit.");
  env.clock.advance(31 * 60_000);
  await env.engine.advanceJob(deal.job_id);
  const q = (await env.engine.getQuotes(deal.job_id)).quotes[0]!;
  await env.engine.requestApproval(deal.job_id, q.quote_id, "imessage");
  const code = approverCode(env);
  expect((await approverText(env, `YES ${code}`)).outcome).toBe("approved");
  return { jobId: deal.job_id, quoteId: q.quote_id, code };
}

/** An email vendor whose mail provider authenticates it quotes, is approved, and confirms the booking in writing. */
async function confirmedEmailBooking(env: Env, opts: { lowerCapAfterApproval?: boolean } = {}) {
  const deal = await env.engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Harbor Table", email: "events@harbor.example" }, { name: "Bay Bites", email: "orders@baybites.example" }] });
  const jobId = deal.job_id;
  env.clock.advance(5 * 60_000);
  await emailReply(env, jobId, "events@harbor.example", "$2,180 total, 14 vegetarian, delivered by 11:00, $500 deposit.");
  await emailReply(env, jobId, "orders@baybites.example", "$2,240 total, 14 vegetarian, delivered by 11:00, $450 deposit.");
  env.clock.advance(31 * 60_000);
  await env.engine.advanceJob(jobId);
  const quotes = (await env.engine.getQuotes(jobId)).quotes;
  const q = quotes.find((x) => x.business === "Harbor Table")!;
  const other = quotes.find((x) => x.business === "Bay Bites")!;
  await env.engine.requestApproval(jobId, q.quote_id, "imessage");
  const code = approverCode(env);
  expect((await approverText(env, `YES ${code}`)).outcome).toBe("approved");
  if (opts.lowerCapAfterApproval) await env.engine.updateSettings({ spending_cap_cents: 30_000 });
  expect((await emailReply(env, jobId, "events@harbor.example", "Confirmed, all set.")).outcome).toBe("booking_confirmed");
  return { jobId, quoteId: q.quote_id, otherQuoteId: other.quote_id, code };
}

describe.each(["sms", "imessage"] as const)("H2: a vendor's texted confirmation (%s) never books on its own", (via) => {
  it("CONFIRMED by text waits for the approver's BOOKED <code>; the model can't pay or book meanwhile", async () => {
    const env = setup({ imessage: via === "imessage" });
    const { jobId, quoteId, code } = await approvedTextDeal(env, via);
    const a = (await env.repo.getLatestApproval(jobId))!;
    env.clock.advance(20 * 60_000);
    expect((await vendorText(env, via, TEXT_VENDOR, "Confirmed! For the $400 deposit, Zelle pay@sunsetkitchen.example")).outcome).toBe("booking_unverified");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("awaiting_vendor_confirmation");
    expect(await env.repo.getHandoffByApproval(a.id)).toBeNull();
    expect(lastToApprover(env)).toMatch(new RegExp(`by text.*reply BOOKED ${code} to accept the booking\\. Don't pay yet`));
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ stage: "awaiting_vendor_confirmation", booked: false });
    const ev = (await env.repo.listEvents(jobId)).filter((e) => e.type === "booking" && e.data.status === "vendor_claims_confirmed").at(-1)!;
    expect(ev.data.sender_identity).toBe("text_only");
    // Every model-reachable path: pay starts nothing, and the vendor itself can't "accept" with the code.
    await env.w.pay(jobId, quoteId).catch(() => null);
    expect(await env.repo.getHandoffByApproval(a.id)).toBeNull();
    expect((await vendorText(env, "sms", TEXT_VENDOR, `BOOKED ${code}`)).outcome).not.toMatch(/booking_confirmed|order_confirmed/);
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("awaiting_vendor_confirmation");

    // The approver checks with the vendor and accepts: only now is it booked; payment details stay unverified.
    expect((await approverText(env, `BOOKED ${code}`)).outcome).toBe("booking_confirmed");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("confirmed");
    const pay = (await env.repo.listEvents(jobId)).filter((e) => e.type === "payment" && e.data.status === "instructions_received").at(-1)!;
    expect(String(pay.data.warning)).toMatch(/confirm these payment details with the business by phone/);
    expect(pay.data.sender_identity).toBe("text_only");
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ booked: true, money_verified: false });
  });

  it("a texted 'received' after the customer reports paying never marks the money received", async () => {
    const env = setup({ imessage: via === "imessage" });
    const { jobId, code } = await approvedTextDeal(env, via);
    const a = (await env.repo.getLatestApproval(jobId))!;
    await vendorText(env, via, TEXT_VENDOR, "Confirmed! For the $400 deposit, Zelle pay@sunsetkitchen.example");
    expect((await approverText(env, `BOOKED ${code}`)).outcome).toBe("booking_confirmed");
    expect((await approverText(env, `PAID ${code}`)).outcome).toBe("handoff_confirmed");
    expect((await env.repo.getJob(jobId))!.state).toBe("paid");
    const h = (await env.repo.getHandoffByApproval(a.id))!;
    expect(h.status).toBe("human_confirmed");

    expect((await vendorText(env, via, TEXT_VENDOR, "Payment received, thanks!")).outcome).not.toBe("receipt_confirmed");
    expect(await env.repo.getHandoffReceipt(h.id)).toBeNull();
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "payment" && e.data.status === "settled_verified")).toBe(false);
    expect((await env.engine.getQuotes(jobId)).purchase).toMatchObject({ money_verified: false });
  });
});

describe("H2: provider-authenticated email still books and verifies as before", () => {
  it("an authenticated email confirmation books without BOOKED; an authenticated 'received' verifies settlement", async () => {
    const env = setup();
    const { jobId, code } = await confirmedEmailBooking(env);
    const a = (await env.repo.getLatestApproval(jobId))!;
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("confirmed");
    expect((await emailReply(env, jobId, "events@harbor.example", "For the $500 deposit, Zelle pay@harbor.example")).outcome).toMatch(/instructions/);
    expect((await approverText(env, `PAID ${code}`)).outcome).toBe("handoff_confirmed");
    expect((await emailReply(env, jobId, "events@harbor.example", "Payment received, thanks!")).outcome).toBe("receipt_confirmed");
  });

  it("trust levels: texts and caller ID are weak identity; provider authentication is not", () => {
    for (const r of ["sms-reply-to-pinned-number", "imessage-from-pinned-number", "inbound-caller-id-match (operator opt-in)"]) {
      expect(provesSenderIdentity({ sender_trusted: true, trust_reason: r })).toBe(false);
      expect(bindingTermsTrust({ sender_trusted: true, trust_reason: r })).toMatchObject({ senderIdentity: "text_only", mayConfirmBooking: false, requiresHumanAck: true, mayNamePayee: false, mayVerifySettlement: false });
    }
    expect(bindingTermsTrust({ sender_trusted: true, trust_reason: "inkbox-same-org" })).toMatchObject({ senderIdentity: "verified", mayConfirmBooking: true, mayVerifySettlement: true });
    expect(bindingTermsTrust({ sender_trusted: true, trust_reason: "external-reply-token" })).toMatchObject({ senderIdentity: "thread_only", mayConfirmBooking: false });
  });
});

describe("H1: caller ID alone is never callback consent", () => {
  const business = { business_id: "biz_1", phone: PHONE_VENDOR, simulated: false, status: "quoted" as const };
  const call = (sender_trusted: boolean, trust_reason: string) => ({ direction: "in" as const, business_id: "biz_1", channel: "phone" as const, matched_via: "caller_number" as const, from_address: PHONE_VENDOR, sender_trusted, trust_reason });

  it("an inbound call matched only by caller ID (even with the operator's caller-ID opt-in) isn't consent", () => {
    for (const m of [call(false, "inbound-caller-id-unverified"), call(true, "inbound-caller-id-match (operator opt-in)")]) {
      const c = callbackConsent({ business, workspaceVendors: [], messages: [m], suppressed: false });
      expect(c).toMatchObject({ ok: false, reason: expect.stringMatching(/caller ID/) });
    }
  });

  it("explicit recorded consent still counts; an authenticated inbound call would too", () => {
    expect(callbackConsent({ business, workspaceVendors: [{ contact: PHONE_VENDOR, consent: "Agreed by phone with the owner, 2026-10-20" }], messages: [], suppressed: false })).toEqual({ ok: true, basis: "workspace_vendor" });
    expect(callbackConsent({ business, workspaceVendors: [], messages: [call(true, "inbound-call-authenticated")], suppressed: false })).toEqual({ ok: true, basis: "called_us" });
  });

  it("engine: a vendor's inbound call with caller-ID trust on doesn't let the operator or approver call it back", async () => {
    const env = setup({ phone: true, trustInboundCallerId: true });
    const deal = await env.engine.deal({ request: REQUEST, budget_usd: 2500, businesses: [{ name: "Mission Eats", phone: PHONE_VENDOR, channel: "phone" }] });
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    expect((await env.engine.ingestCall({ callId: "in_call_h1", outcome: "completed", transcript: "remote: Hi, it's Mission Eats calling about the quote.", direction: "inbound", remoteNumber: PHONE_VENDOR })).jobId).toBe(deal.job_id);
    expect(await env.engine.callbackConsentFor(deal.job_id, b.business_id)).toMatchObject({ ok: false, reason: expect.stringMatching(/caller ID/) });
    const before = env.calls.length;
    await expect(env.engine.operatorCallback(deal.job_id, b.business_id, "ops-alice")).rejects.toBeTruthy();
    expect(env.calls).toHaveLength(before);
  });
});

describe("H3: cancelling a vendor-confirmed booking needs the approver's CANCEL <code>", () => {
  it("cancel_deal on a confirmed booking only texts the approver; nothing is cancelled or sent to the vendor", async () => {
    const env = setup();
    const { jobId } = await confirmedEmailBooking(env);
    const a = (await env.repo.getLatestApproval(jobId))!;
    const toVendor = env.emails.filter((e) => e.to === "events@harbor.example").length;
    const r = await env.w.cancel(jobId);
    expect(r).toMatchObject({ ok: true, state: "paying", needs_approver: true });
    expect(JSON.stringify(r)).not.toMatch(/\d{6}/); // the code goes only to the approver's phone
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("confirmed");
    expect((await env.repo.getApproval(a.id))!.status).toBe("approved");
    expect(env.emails.filter((e) => e.to === "events@harbor.example")).toHaveLength(toVendor);
    expect(lastToApprover(env)).toMatch(/Reply CANCEL \d{6} to cancel/);
  });

  it("the approver's CANCEL <code> cancels it and tells the vendor; a wrong code, another number or an old code doesn't", async () => {
    const env = setup();
    const { jobId } = await confirmedEmailBooking(env);
    await env.w.cancel(jobId);
    const first = /CANCEL (\d{6})/.exec(lastToApprover(env))![1]!;
    await env.w.cancel(jobId); // a second request supersedes the first code
    const code = /CANCEL (\d{6})/.exec(lastToApprover(env))![1]!;
    if (first !== code) expect((await approverText(env, `CANCEL ${first}`)).outcome).toBe("cancel_no_match");
    expect((await env.engine.ingestText({ messageId: "vend_cancel", from: TEXT_VENDOR, text: `CANCEL ${code}`, inbound: true })).outcome).not.toBe("cancelled");
    expect((await approverText(env, "CANCEL 000000")).outcome).toBe("cancel_no_match");
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
    const toVendor = env.emails.filter((e) => e.to === "events@harbor.example").length;
    expect((await approverText(env, `CANCEL ${code}`)).outcome).toBe("cancelled");
    expect((await env.repo.getJob(jobId))!.state).toBe("cancelled");
    expect(env.emails.filter((e) => e.to === "events@harbor.example").slice(toVendor).some((e) => /don't hold the booking/i.test(e.bodyText))).toBe(true);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "cancel_auth_decided" && e.data.decision === "authorized")).toBe(true);
  });

  it("an expired code or too many wrong codes cancels nothing", async () => {
    const env = setup();
    const { jobId } = await confirmedEmailBooking(env);
    await env.w.cancel(jobId);
    const code = /CANCEL (\d{6})/.exec(lastToApprover(env))![1]!;
    env.clock.advance(31 * 60_000);
    expect((await approverText(env, `CANCEL ${code}`)).outcome).toBe("cancel_no_match");
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");

    await env.w.cancel(jobId);
    const fresh = /CANCEL (\d{6})/.exec(lastToApprover(env))![1]!;
    for (let i = 0; i < 5; i++) await approverText(env, `CANCEL ${String((Number(fresh) + 1 + i) % 1_000_000).padStart(6, "0")}`);
    expect((await approverText(env, `CANCEL ${fresh}`)).outcome).toBe("cancel_no_match");
    expect((await env.repo.getJob(jobId))!.state).toBe("paying");
  });

  it("before the vendor confirms, cancel_deal still cancels at once (the existing safe workflow)", async () => {
    const env = setup();
    const { jobId } = await approvedTextDeal(env, "sms");
    const r = await env.w.cancel(jobId);
    expect(r).toMatchObject({ ok: true, state: "cancelled" });
    expect((r as { needs_approver?: boolean }).needs_approver).toBeUndefined();
  });

  it("re-approving another quote can't withdraw a confirmed booking either", async () => {
    const env = setup();
    const { jobId, otherQuoteId } = await confirmedEmailBooking(env, { lowerCapAfterApproval: true });
    const a = (await env.repo.getLatestApproval(jobId))!;
    expect(await env.repo.getHandoffByApproval(a.id)).toBeNull(); // the handoff was refused (cap lowered)
    await expect(env.w.requestApproval(jobId, otherQuoteId, "imessage")).rejects.toBeTruthy();
    expect((await env.repo.getBookingByApproval(a.id))!.status).toBe("confirmed");
    expect((await env.repo.getApproval(a.id))!.status).toBe("approved");
  });
});
