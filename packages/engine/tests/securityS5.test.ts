// Sprint 5 adversarial review (workstream D): regression tests for findings confirmed by trace and
// probe. Real engine, in-memory store, fake ports, no network. See docs/security-review-s5.md.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig } from "../src/index.ts";
import { simulatedStripe } from "../src/payments/stripe.ts";
import { checkMessage, citesCompetingOffer } from "../src/negotiation/messageGuard.ts";

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

async function setup(config: Partial<EngineConfig> = {}) {
  const texts: { to: string; text: string }[] = [];
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"), stripe: simulatedStripe(),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall() { return { callId: `call_${Math.random()}` }; } },
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
  }
  return { engine, repo, texts, emails };
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
