// Sprint 5 adversarial review (workstream D): regression tests for findings confirmed by trace and
// probe. Real engine, in-memory store, fake ports, no network. See docs/security-review-s5.md.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig } from "../src/index.ts";
import { simulatedStripe } from "../src/payments/stripe.ts";
import { ChannelSendError } from "../src/workflow/ports.ts";
import { DEFAULT_CONTACT_WINDOW } from "../src/workflow/contactWindow.ts";
import { checkMessage, citesCompetingOffer } from "../src/negotiation/messageGuard.ts";
import { verifyApprover } from "./helpers/verifiedApprover.ts";

const ALPHA_PHONE = "+14155550101";
const BETA_PHONE = "+14155550202";
const OPERATOR_PHONE = "+14155550999";
const NEW_ALPHA_PHONE = "+14155550777";
const { budget_usd, ...request } = GOLDEN_REQUEST;
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText;
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*total/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    return {
      available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      sources: [...(total !== null ? [{ field: "total" as const, source: "email body", excerpt: `$${total} total` }] : []), ...(deposit !== null ? [{ field: "deposit" as const, source: "email body", excerpt: `$${deposit} deposit` }] : [])],
      missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

async function setup(config: Partial<EngineConfig> = {}, ports: { emailError?: (to: string) => Error | undefined } = {}) {
  const texts: { to: string; text: string }[] = [];
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const calls: { toNumber: string }[] = [];
  let t = Date.parse("2026-10-20T19:00:00Z"); // a Tuesday, noon Pacific (call hours)
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), stripe: simulatedStripe(),
    email: { async send(m) { const e = ports.emailError?.(m.to); if (e) throw e; emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall(c: { toNumber: string }) { calls.push(c); return { callId: `call_${calls.length}` }; } },
    sms: { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } },
    voice: { async setInstructions() {} },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, notifyPhone: OPERATOR_PHONE, ...config,
    },
  });
  for (const [id, phone] of [["ws_alpha", ALPHA_PHONE], ["ws_beta", BETA_PHONE]] as const) {
    await repo.insertWorkspace({ id, name: id, token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    await engine.updateSettings({ approver_phone: phone, spending_cap_cents: 150_000 }, id); // the operator
    await verifyApprover(repo, id, phone);
  }
  return { engine, repo, clock, texts, emails, calls };
}

/** A deal in `ws` with one firm quote ($1,150 total, $345 deposit). */
async function quotedIn(env: Awaited<ReturnType<typeof setup>>, ws: string, n = 1) {
  const agent = env.engine.forWorkspace(ws);
  const email = `harbor${n}-${ws}@inkboxmail.test`;
  const deal = await agent.deal({ request, budget_usd, businesses: [{ name: `Harbor Table ${n}`, email }] });
  const rfq = (await env.repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!;
  await env.engine.ingest({ providerEventId: `e-${ws}-${n}`, eventType: "message.received", providerEmailId: `in-${ws}-${n}`, threadId: `t-${ws}-${n}`, messageId: `<in-${ws}-${n}@x>`, inReplyTo: [rfq], references: [rfq], from: email, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "$1,150 total, 12 vegetarian, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
  await env.engine.advanceJob(deal.job_id);
  const q = (await agent.getQuotes(deal.job_id)).quotes.find((x) => x.business === `Harbor Table ${n}`)!;
  return { agent, jobId: deal.job_id, quoteId: q.quote_id };
}

describe("S5-D F1: a replaced approver's phone can no longer decide", () => {
  it("YES <code> from the old approver after the operator changes the approver leaves the approval pending; the new approver can approve", async () => {
    const env = await setup();
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "imessage");
    expect(env.texts.some((t) => t.to === ALPHA_PHONE && t.text.includes(a.code))).toBe(true);
    await env.engine.updateSettings({ approver_phone: NEW_ALPHA_PHONE }, "ws_alpha"); // the operator (lost phone)
    const r = await env.engine.ingestText({ messageId: "old-yes", from: ALPHA_PHONE, text: `YES ${a.code}`, inbound: true });
    expect(r.outcome).not.toBe("approved");
    expect((await env.repo.getApproval(a.id))!.status).toBe("pending");
    expect(await env.engine.ingestText({ messageId: "new-yes", from: NEW_ALPHA_PHONE, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
  });

  it("a bare NO from the old approver doesn't decline", async () => {
    const env = await setup();
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "imessage");
    await env.engine.updateSettings({ approver_phone: NEW_ALPHA_PHONE }, "ws_alpha");
    const r = await env.engine.ingestText({ messageId: "old-no", from: ALPHA_PHONE, text: "NO", inbound: true });
    expect(r.outcome).not.toBe("declined");
    expect((await env.repo.getApproval(a.id))!.status).toBe("pending");
  });
});

describe("S5-D F2: a coded text from a number that approves for no open deal touches no workspace", () => {
  it("the operator's notify number (default workspace only) texting YES <code> stores nothing on another workspace's deal and texts nobody there", async () => {
    const env = await setup();
    const { jobId } = await quotedIn(env, "ws_alpha");
    const before = env.texts.length;
    const r = await env.engine.ingestText({ messageId: "op1", from: OPERATOR_PHONE, text: "YES 1234", inbound: true });
    expect(r.jobId).toBeNull();
    expect((await env.repo.listMessages(jobId)).filter((m) => m.from_address === OPERATOR_PHONE)).toHaveLength(0);
    expect(env.texts.slice(before).filter((t) => t.to === ALPHA_PHONE)).toHaveLength(0);
  });
});

describe("S5-D F5: wrong approval codes count when the approver has several pending approvals", () => {
  it("guessing YES <code> against two pending approvals locks them instead of allowing unlimited tries", async () => {
    const env = await setup();
    const one = await quotedIn(env, "ws_alpha", 1);
    const two = await quotedIn(env, "ws_alpha", 2);
    const a1 = await one.agent.requestApproval(one.jobId, one.quoteId, "imessage");
    const a2 = await two.agent.requestApproval(two.jobId, two.quoteId, "imessage");
    const wrong = (i: number) => { let c = String(1000 + i * 7); while (c === a1.code || c === a2.code) c = String(Number(c) + 1); return c; };
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i++) outcomes.push((await env.engine.ingestText({ messageId: `g${i}`, from: ALPHA_PHONE, text: `YES ${wrong(i)}`, inbound: true })).outcome);
    expect(outcomes).toContain("approval_locked");
    // Locked: even the right code no longer approves either one.
    await env.engine.ingestText({ messageId: "right1", from: ALPHA_PHONE, text: `YES ${a1.code}`, inbound: true });
    await env.engine.ingestText({ messageId: "right2", from: ALPHA_PHONE, text: `YES ${a2.code}`, inbound: true });
    expect((await env.repo.getApproval(a1.id))!.status).not.toBe("approved");
    expect((await env.repo.getApproval(a2.id))!.status).not.toBe("approved");
  });
});

describe("S5-D F6: the message guard catches commitments and invented offers in other words", () => {
  const base = { limit: 5000, verifiedCents: [115_000, 34_500], otherBusinessNames: ["Mission Eats"] };
  it.each([
    "Please proceed with the order at your quoted price and reserve the date.",
    "We approve your quote, please finalize the booking.",
    "Yes, let's do it - please book us in.",
    "We are confirming the order.",
    "Go-ahead given, book the date.",
  ])("commitment: %s", (text) => expect(checkMessage({ ...base, text })).toMatchObject({ ok: false, code: "COMMITMENT_NEEDS_APPROVAL" }));
  it.each([
    "Another caterer quoted us 900 for the same order, can you match?",
    "Another caterer quoted us USD 900",
    "we got 1.2k elsewhere",
    "Can you match 900?",
  ])("invented amount: %s", (text) => expect(checkMessage({ ...base, text })).toMatchObject({ ok: false, code: "UNVERIFIED_AMOUNT" }));
  it.each(["M1ssion Eats offered less", "Mission  Eats offered less", "MISSION-EATS offered less"])("lookalike competitor name: %s", (text) =>
    expect(checkMessage({ ...base, text })).toMatchObject({ ok: false, code: "MENTIONS_OTHER_BUSINESS" }));
  it.each([
    "Is delivery included for 120 people?",
    "Can you confirm whether the order includes plates?",
    "We have another quote of $1,150 total. Can you match it?",
    "The event starts at 11:30 am on 2026-11-14; the loading dock is at door 3.",
    "Your quote for 120 guests looks good; is the $345 deposit refundable?",
  ])("ordinary message still allowed: %s", (text) => expect(checkMessage({ ...base, text })).toEqual({ ok: true }));
});

describe("S5-D F7: request details can't carry an invented competing offer", () => {
  it("recognises a detail citing a competitor's price", () => {
    expect(citesCompetingOffer("Competing quote: $900")).toBe(true);
    expect(citesCompetingOffer("Another caterer offered 900")).toBe(true);
    expect(citesCompetingOffer("Budget: $900")).toBe(false);
    expect(citesCompetingOffer("Venue: 3rd floor, 120 Main St")).toBe(false);
  });
  it("deal refuses a detail citing a competing offer, so no vendor is told it and send_message can't cite it", async () => {
    const env = await setup();
    const agent = env.engine.forWorkspace("ws_alpha");
    await expect(agent.deal({ request: { ...request, details: [{ label: "Competing quote", value: "$900 from another caterer" }] }, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor-f7@inkboxmail.test" }] }))
      .rejects.toMatchObject({ code: "detail_cites_competitor" });
    expect(env.emails).toHaveLength(0);
  });
});

describe("S5-D F8: a held BOOKED text is never attributed by an operator", () => {
  it("BOOKED <code> from an approver of two workspaces is held and can't be released to a deal", async () => {
    const env = await setup();
    await env.engine.updateSettings({ approver_phone: ALPHA_PHONE }, "ws_beta"); // the operator: one human approves for both
    const a = await quotedIn(env, "ws_alpha", 1);
    await quotedIn(env, "ws_beta", 2);
    expect((await env.engine.ingestText({ messageId: "bk1", from: ALPHA_PHONE, text: "BOOKED 4821", inbound: true })).outcome).toBe("ambiguous_workspace");
    const held = (await env.repo.findMessageByProviderId("sms-in:bk1"))!;
    await expect(env.engine.releaseHeldText(held.id, a.jobId, "ops-alice")).rejects.toMatchObject({ code: "decision_not_releasable" });
  });
});

describe("S5-D F9: an @domain allowlist entry authorizes email addresses only", () => {
  it("an Agent Card URL that merely ends in @vendor.com is not authorized", async () => {
    const env = await setup({ recipientAllowlist: ["@vendor.com"] });
    expect(env.engine.canContact({ email: "sales@vendor.com" })).toBe(true);
    expect(env.engine.canContact({ a2a_card_url: "https://attacker.example/@vendor.com" })).toBe(false);
    expect(env.engine.canContact({ a2a_card_url: "https://attacker.example/c.json?x=@vendor.com" })).toBe(false);
    expect(env.engine.canContact({ email: "x@attacker.example" })).toBe(false);
    expect(await env.engine.mayContact({ a2a_card_url: "https://attacker.example/@vendor.com" }, "ws_alpha")).toBe(false);
  });
});

describe("S5-D F10: a business that asked not to be contacted is never contacted again on any channel", () => {
  const VENDOR_PHONE = "+14155550444";
  async function stopped(verified: boolean) {
    const env = await setup({}, {});
    const agent = env.engine.forWorkspace("ws_alpha");
    const email = `stop-${verified ? "v" : "u"}@inkboxmail.test`;
    const deal = await agent.deal({ request, budget_usd, businesses: [{ name: "Stop Grill", email, phone: VENDOR_PHONE }] });
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    const untrusted = () => ({ trusted: false as const, retryable: false as const, reason: "unverified-external-sender" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
    const r = await env.engine.ingest({ providerEventId: `stop-${email}`, eventType: "message.received", providerEmailId: `stop-${email}`, threadId: "ts", messageId: `<stop-${email}>`, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: email, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "Please stop emailing us.", attachments: [], attachmentsDownloadUrl: null }, verified ? trusted : untrusted);
    expect(r.outcome).toBe("opted_out");
    return { env, agent, jobId: deal.job_id, businessId: b.business_id };
  }
  for (const verified of [true, false]) {
    it(`after a ${verified ? "verified" : "unverified"} email STOP, send_message is refused on email, text and phone`, async () => {
      const { env, agent, jobId, businessId } = await stopped(verified);
      const before = { e: env.emails.length, t: env.texts.length, c: env.calls.length };
      for (const channel of ["email", "imessage", "phone"] as const) {
        await expect(agent.sendMessage(jobId, businessId, { text: "Is delivery included?", channel })).rejects.toMatchObject({ code: "business_opted_out" });
      }
      expect({ e: env.emails.length, t: env.texts.length, c: env.calls.length }).toEqual(before);
    });
  }

  it("an email refused because the recipient opted out is never escalated to a Voice AI call", async () => {
    const env = await setup({ escalateEmailToCallAfterMs: 60_000 }, { emailError: (to) => (to === "optout-esc@inkboxmail.test" ? new ChannelSendError("opted_out", false, 0, "recipient opted out") : undefined) });
    const deal = await env.engine.forWorkspace("ws_alpha").deal({ request, budget_usd, businesses: [{ name: "Esc Grill", email: "optout-esc@inkboxmail.test", phone: VENDOR_PHONE }] });
    await env.engine.advanceJob(deal.job_id);
    expect(env.calls.filter((c) => c.toNumber === VENDOR_PHONE)).toHaveLength(0);
  });
});

describe("S5-D F11: on a live server the agent's send_message can't stand in for an approver-authorized callback", () => {
  const PHONE_VENDOR = "+14155550555";
  it("a phone vendor gets at most one agent-written call per deal, never one citing a price", async () => {
    const env = await setup({ callCooldownMs: 0 }); // no spacing: only the per-deal limit stops the second call
    const agent = env.engine.forWorkspace("ws_alpha");
    const deal = await agent.deal({ request, budget_usd, businesses: [{ name: "Phone Grill", phone: PHONE_VENDOR }] });
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    env.clock.advance(30 * 60_000);
    const callsBefore = env.calls.length;
    await expect(agent.sendMessage(deal.job_id, b.business_id, { text: "Could you beat $1,150?" })).rejects.toMatchObject({ code: "call_cites_price" });
    const first = await agent.sendMessage(deal.job_id, b.business_id, { text: "Do you have vegetarian options?" });
    expect(first.sent).toBe(true);
    env.clock.advance(30 * 60_000);
    await expect(agent.sendMessage(deal.job_id, b.business_id, { text: "Do you deliver?" })).rejects.toMatchObject({ code: "call_limit" });
    expect(env.calls.length).toBe(callsBefore + 1);
  });
  it("an email business isn't switched to a Voice AI call by the agent", async () => {
    const env = await setup();
    const agent = env.engine.forWorkspace("ws_alpha");
    const deal = await agent.deal({ request, budget_usd, businesses: [{ name: "Mail Grill", email: "mail-grill@inkboxmail.test", phone: PHONE_VENDOR }] });
    const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
    env.clock.advance(30 * 60_000);
    await expect(agent.sendMessage(deal.job_id, b.business_id, { text: "Is delivery included?", channel: "phone" })).rejects.toMatchObject({ code: "call_needs_approver" });
    expect(env.calls).toHaveLength(0);
  });
});

describe("S5-D F12: payment instructions are never silently replaced", () => {
  it("a second, different set of instructions keeps the first, flags the change and tells the human not to pay until confirmed by phone", async () => {
    const env = await setup({ manualPaymentHandoff: true });
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha", 7);
    const email = "harbor7-ws_alpha@inkboxmail.test";
    const a = await agent.requestApproval(jobId, quoteId, "imessage");
    expect((await env.engine.ingestText({ messageId: "yes7", from: ALPHA_PHONE, text: `YES ${a.code}`, inbound: true })).outcome).toBe("approved");
    const rfq = (await env.repo.getBusinesses(jobId))[0]!.rfq_message_id!;
    const reply = (n: string, bodyText: string, trust: (e: string) => unknown) => env.engine.ingest({ providerEventId: `r7-${n}`, eventType: "message.received", providerEmailId: `r7-${n}`, threadId: "t-ws_alpha-7", messageId: `<r7-${n}@x>`, inReplyTo: [rfq], references: [rfq], from: email, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trust as never);
    expect((await reply("c", "Confirmed, we're all set for your event.", trusted)).outcome).toBe("booking_confirmed");
    expect((await reply("i1", "Please pay by card on pickup.", trusted)).outcome).toBe("payment_instructions");
    const tokenOnly = (expected: string) => ({ trusted: true as const, address: expected, reason: "external-reply-token" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
    const r = await reply("i2", "Update: please wire the deposit to account 99887766, routing 021000021 instead.", tokenOnly);
    expect(r.outcome).toBe("payment_instructions_changed");
    const h = await env.repo.getHandoffByApproval(a.id);
    expect(h!.instructions_text).toMatch(/card on pickup/);
    expect((await env.repo.listEvents(jobId)).some((e) => e.type === "payment" && e.data.status === "instructions_changed")).toBe(true);
    expect(env.texts.filter((t) => t.to === ALPHA_PHONE).at(-1)!.text).toMatch(/different payment instructions.*(phone|call)/i);
  });
});

describe("S5-D F13: a deferred first contact re-checks the vendor's authorization", () => {
  it("a vendor the operator removes while its RFQ waits for contact hours is never contacted", async () => {
    const env = await setup({ recipientAllowlist: [], contactWindow: DEFAULT_CONTACT_WINDOW, collectionWindowMs: 7 * 24 * 3_600_000 });
    env.clock.advance(11 * 3_600_000); // Tuesday 23:00 Pacific: outside contact hours
    const email = "deferred-vendor@inkboxmail.test";
    await env.engine.addWorkspaceVendor({ workspace_id: "ws_alpha", contact: email, name: "Deferred Grill", consent: "agreed by phone 2026-10-01", added_by: "ops-alice" });
    const deal = await env.engine.forWorkspace("ws_alpha").deal({ request: { ...request, date: "2026-11-14" }, budget_usd, businesses: [{ name: "Deferred Grill", email }] });
    expect(env.emails.filter((m) => m.to === email)).toHaveLength(0);
    expect((await env.repo.getBusinesses(deal.job_id))[0]!.next_attempt_at).not.toBeNull();
    await env.engine.removeWorkspaceVendor("ws_alpha", email); // consent withdrawn overnight
    env.clock.advance(10 * 3_600_000); // Wednesday 09:00 Pacific
    await env.engine.advanceJob(deal.job_id);
    expect(env.emails.filter((m) => m.to === email)).toHaveLength(0);
  });
});

describe("S5-D F14: an approval's terms are immutable and a decided approval never comes back (store parity with 121)", () => {
  it("the in-memory store refuses changing an approval's quote, amounts, business or amounts, and resurrecting a used or declined approval", async () => {
    const env = await setup();
    const { agent, jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const a = await agent.requestApproval(jobId, quoteId, "imessage");
    for (const patch of [{ quote_id: "q_other" }, { payment_cents: 1 }, { quote_total_cents: 1 }, { business_id: "biz_other" }, { cap_cents: 999_999 }, { job_id: "job_other" }]) {
      await expect(env.repo.updateApproval(a.id, patch)).rejects.toThrow(/immutable/);
      await expect(env.repo.transitionApproval(a.id, "pending", { status: "approved", ...patch })).rejects.toThrow(/immutable/);
    }
    expect(await env.repo.transitionApproval(a.id, "pending", { status: "declined", decided_at: new Date().toISOString() })).toBe(true);
    await expect(env.repo.transitionApproval(a.id, "declined", { status: "approved" })).rejects.toThrow(/approval status/);
    expect((await env.repo.getApproval(a.id))!.status).toBe("declined");
  });
  it("the in-memory store refuses an approval that doesn't name its own job's quote, business and total", async () => {
    const env = await setup();
    const { jobId, quoteId } = await quotedIn(env, "ws_alpha");
    const q = (await env.repo.getQuote(quoteId))!;
    const base = { id: "ap_forged", job_id: jobId, quote_id: quoteId, business_id: q.business_id, quote_total_cents: q.total_cents!, payment_cents: q.deposit_cents!, cap_cents: 150_000, approver: null, channel: "imessage" as const, status: "pending" as const, code: "1234", expires_at: new Date(Date.now() + 60_000).toISOString(), decided_at: null, outbound_message_id: null, thread_id: null, action: "pay" as const, attempts: 0 };
    await expect(env.repo.insertApproval({ ...base, business_id: "biz_other" })).rejects.toThrow(/own job's quote/);
    await expect(env.repo.insertApproval({ ...base, quote_total_cents: 1 })).rejects.toThrow(/own job's quote/);
  });
});

describe("S5-D F10b: a business that said STOP after quoting gets no counteroffer", () => {
  it("negotiate skips a quoted business that then asked not to be contacted (unverified STOP: no suppression, declined on this deal)", async () => {
    const env = await setup();
    const agent = env.engine.forWorkspace("ws_alpha");
    const hi = "hi-stop@inkboxmail.test", lo = "lo-quote@inkboxmail.test";
    const deal = await agent.deal({ request, budget_usd, businesses: [{ name: "High Grill", email: hi }, { name: "Low Grill", email: lo }] });
    const rows = await env.repo.getBusinesses(deal.job_id);
    const send = (n: string, from: string, bodyText: string, trust: unknown) => {
      const rfq = rows.find((b) => b.email === from)!.rfq_message_id!;
      return env.engine.ingest({ providerEventId: `n-${n}`, eventType: "message.received", providerEmailId: `n-${n}`, threadId: `t-${from}`, messageId: `<n-${n}@x>`, inReplyTo: [rfq], references: [rfq], from, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trust as never);
    };
    await send("hq", hi, "$1,150 total, 12 vegetarian, delivered. $345 deposit.", trusted);
    await send("lq", lo, "$900 total, 12 vegetarian, delivered. $200 deposit.", trusted);
    const untrusted = () => ({ trusted: false as const, retryable: false as const, reason: "unverified-external-sender" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
    expect((await send("hs", hi, "Please stop emailing us.", untrusted)).outcome).toBe("opted_out");
    const before = env.emails.filter((m) => m.to === hi).length;
    env.clock.advance(2 * 3_600_000); // quotes final: Haggle's own counter round runs
    await env.engine.advanceJob(deal.job_id);
    await agent.negotiate(deal.job_id).catch(() => null);
    await env.engine.advanceJob(deal.job_id);
    expect(env.emails.filter((m) => m.to === hi).length).toBe(before);
    expect((await env.repo.listEvents(deal.job_id)).some((e) => /Counteroffer to High Grill/.test(String(e.data.summary)))).toBe(false);
  });
});

describe("S5 H9: a business that said STOP after quoting can't be approved", () => {
  it("approving its earlier quote is refused with business_opted_out; the other quote still can be", async () => {
    const env = await setup();
    const agent = env.engine.forWorkspace("ws_alpha");
    const hi = "h9-stop@inkboxmail.test", lo = "h9-quote@inkboxmail.test";
    const deal = await agent.deal({ request, budget_usd, businesses: [{ name: "Stop Grill", email: hi }, { name: "Stay Grill", email: lo }] });
    const rows = await env.repo.getBusinesses(deal.job_id);
    const send = (n: string, from: string, bodyText: string) => {
      const rfq = rows.find((b) => b.email === from)!.rfq_message_id!;
      return env.engine.ingest({ providerEventId: `h9-${n}`, eventType: "message.received", providerEmailId: `h9-${n}`, threadId: `t-${from}`, messageId: `<h9-${n}@x>`, inReplyTo: [rfq], references: [rfq], from, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted as never);
    };
    await send("q1", hi, "$900 total, 12 vegetarian, delivered. $200 deposit.");
    await send("q2", lo, "$1,000 total, 12 vegetarian, delivered. $250 deposit.");
    expect((await send("s1", hi, "Please stop emailing us.")).outcome).toBe("opted_out");
    env.clock.advance(2 * 3_600_000);
    await env.engine.advanceJob(deal.job_id);
    const quotes = await env.repo.listQuotes(deal.job_id);
    const stopBiz = rows.find((b) => b.email === hi)!.business_id;
    const stopQuote = quotes.find((q) => q.business_id === stopBiz)!;
    const okQuote = quotes.find((q) => q.business_id !== stopBiz)!;
    await expect(agent.requestApproval(deal.job_id, stopQuote.id, "view")).rejects.toMatchObject({ code: "business_opted_out" });
    await expect(agent.requestApproval(deal.job_id, okQuote.id, "view")).resolves.toMatchObject({ quote_id: okQuote.id });
  });
});
