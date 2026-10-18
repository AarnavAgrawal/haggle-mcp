// SMS from the buyer identity's own number (Inkbox sendText): update texts to the human (new quote,
// a business question, a finished call, quotes ready), the human's reply answering the open
// question, and follow-ups to phone businesses whose call left the total unclear. Real engine, fake
// Inkbox ports; no network.
import { describe, expect, it } from "vitest";
import { inkboxSms } from "../src/live/inkbox.ts";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type EngineConfig, type SmsPort } from "../src/index.ts";
import { simulatedStripe, type StripePort } from "../src/payments/stripe.ts";

const HUMAN = "+14155550199";

// Reads figures and questions out of free text, like the Claude extractor does live.
const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = i.bodyText.split("\n").filter((l) => !/^\s*(local|haggle)\s*:/i.test(l)).join("\n");
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[- ]in)/i);
    const perHead = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:a|per) (?:head|person)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const questions = t.split(/(?<=\?)/).map((s) => s.trim()).filter((s) => s.endsWith("?"));
    const sources = [
      ...(total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []),
      ...(perHead !== null ? [{ field: "price_per_head" as const, source: "text", excerpt: `$${perHead} per person` }] : []),
      ...(deposit !== null ? [{ field: "deposit" as const, source: "text", excerpt: `$${deposit} deposit` }] : []),
    ];
    return {
      available: true, price_per_head_usd: perHead, headcount: perHead !== null ? 40 : null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: total === null && perHead === null ? questions : [], payment_request: "none" as const, instructions_to_agent: false,
      sources, missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

function demoEngine(opts: { sms?: boolean; notifyPhone?: string | null; smsPort?: SmsPort; config?: Partial<EngineConfig>; stripe?: StripePort } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; subject: string; bodyText: string }[] = [];
  const texts: { to: string; text: string; idempotencyKey: string }[] = [];
  const calls: { toNumber: string }[] = [];
  const logs: { event: string; data: Record<string, unknown> }[] = [];
  const sms: SmsPort = opts.smsPort ?? { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } };
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
    ...(opts.sms === false ? {} : { sms }),
    ...(opts.stripe ? { stripe: opts.stripe } : {}),
    log: (event, data) => { logs.push({ event, data }); },
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 50_000, maxRounds: 2, ...(opts.notifyPhone === null ? {} : { notifyPhone: opts.notifyPhone ?? HUMAN }), ...opts.config,
    },
  });
  return { engine, repo, clock, emails, texts, calls, logs };
}

/**
 * Inkbox's SMS spam filter as seen live (deployment #26 logs): after 10 texts to one number with no
 * reply, sendText fails with 422 message_blocked_spam_filter / unanswered_limit until it texts back.
 */
function inkboxLikeSms(limit = 10) {
  const sent: { to: string; text: string; idempotencyKey: string }[] = [];
  const refused: { to: string; text: string }[] = [];
  const unanswered = new Map<string, number>();
  const port: SmsPort = {
    async send(r) {
      const n = unanswered.get(r.to) ?? 0;
      if (n >= limit) {
        refused.push(r);
        throw Object.assign(new Error(`HTTP 422: {"error":"message_blocked_spam_filter","rule":"unanswered_limit","message":"Already sent ${limit} messages to this recipient with no reply. Wait for a reply before sending more."}`), { statusCode: 422, detail: { error: "message_blocked_spam_filter", rule: "unanswered_limit" } });
      }
      unanswered.set(r.to, n + 1);
      sent.push(r);
      return { messageId: `sms_${sent.length}` };
    },
  };
  return { port, sent, refused, replied: (from: string) => unanswered.set(from, 0), seed: (to: string, n: number) => unanswered.set(to, n) };
}

const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const { budget_usd, ...request } = GOLDEN_REQUEST;

async function emailReply(engine: HaggleEngine, repo: InMemoryRepository, jobId: string, n: number, bodyText: string) {
  const rfq = (await repo.getBusinesses(jobId)).find((b) => b.name === "Harbor Table")!.rfq_message_id!;
  await engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: "t1", messageId: `<in_${n}@x>`, inReplyTo: [rfq], references: [rfq], from: "harbor@inkboxmail.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
  await engine.advanceJob(jobId);
}

describe("SMS updates to the human", () => {
  it("texts each new quote once, says when it came from the call, and never echoes to anyone else", async () => {
    const { engine, repo, texts } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: "+14155550104" }] });
    await emailReply(engine, repo, deal.job_id, 1, "Happy to help: $1,150 total, 12 vegetarian, delivered. $345 deposit.");
    await engine.advanceJob(deal.job_id);
    expect(texts.filter((x) => /Harbor Table quoted \$1,150/.test(x.text))).toHaveLength(1);

    await engine.advanceJob(deal.job_id);
    expect((await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "local: Hi, this is Haggle, an AI assistant.\nremote: $995 total all-in, delivered, $150 deposit." })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    const human = texts.filter((x) => x.to === HUMAN);
    expect(human.map((x) => x.text)).toEqual(expect.arrayContaining([expect.stringMatching(/Mission Eats quoted \$995 on the call/)]));
    expect(human.every((x) => x.text.startsWith("Haggle: ") && x.text.length <= 320)).toBe(true);
    expect(new Set(texts.map((x) => x.idempotencyKey)).size).toBe(texts.length);
  });

  it("texts a business question; the human's text reply is sent to the business as the answer", async () => {
    const { engine, repo, texts, emails } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    await emailReply(engine, repo, deal.job_id, 1, "Before I quote: should we stay to set up and serve, or is a drop-off fine?");
    const ask = texts.find((x) => /Harbor Table asks/.test(x.text));
    expect(ask).toMatchObject({ to: HUMAN });
    expect(ask!.text).toMatch(/Reply to this text to answer/);

    const r = await engine.ingestText({ messageId: "sms_in_1", from: HUMAN, text: "Drop-off is fine, no need to stay.", inbound: true });
    expect(r).toMatchObject({ jobId: deal.job_id, outcome: "answered" });
    expect(emails.at(-1)!.bodyText).toMatch(/Drop-off is fine, no need to stay\./);
    expect((await repo.listQuestions(deal.job_id))[0]).toMatchObject({ status: "answered" });
    // Webhook redelivery: answered once.
    expect((await engine.ingestText({ messageId: "sms_in_1", from: HUMAN, text: "Drop-off is fine, no need to stay.", inbound: true })).outcome).toBe("duplicate");
  });

  it("texts when a call goes unanswered, and when the deal ends without a quote", async () => {
    const { engine, clock, texts } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Quiet Bistro", phone: "+14155550122" }] });
    await engine.advanceJob(deal.job_id);
    await engine.ingestCall({ callId: "call_1", outcome: "no_answer", transcript: "" });
    expect(texts.some((x) => x.to === HUMAN && /call to Quiet Bistro ended: no answer/i.test(x.text))).toBe(true);
    clock.advance(31 * 60_000);
    await engine.advanceJob(deal.job_id);
    await engine.advanceJob(deal.job_id);
    expect(texts.some((x) => x.to === HUMAN && /ended without a usable quote/.test(x.text))).toBe(true);
  });

  it("texts once when quotes are final, naming the ranker's best eligible quote", async () => {
    const { engine, repo, clock, texts } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    await emailReply(engine, repo, deal.job_id, 1, "Happy to help: $1,150 total, 12 vegetarian, delivered. $345 deposit.");
    for (let i = 0; i < 3; i++) { clock.advance(31 * 60_000); await engine.advanceJob(deal.job_id); }
    const ready = texts.filter((x) => x.to === HUMAN && /are in\. Best: Harbor Table at \$1,150/.test(x.text));
    expect(ready).toHaveLength(1);
  });

  it("sends nothing without the SMS port or a number to text", async () => {
    for (const opts of [{ sms: false }, { notifyPhone: null }]) {
      const { engine, repo, texts } = demoEngine(opts);
      const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
      await emailReply(engine, repo, deal.job_id, 1, "$1,150 total, delivered, $345 deposit.");
      expect(texts).toHaveLength(0);
    }
  });

  it("ignores texts from numbers Haggle never texted", async () => {
    const { engine } = demoEngine();
    expect((await engine.ingestText({ messageId: "x", from: "+14155550999", text: "$1 total!", inbound: true })).outcome).toBe("unknown_sender");
  });
});

describe("follow-up to a phone business stays on the phone (never an SMS)", () => {
  it("a call without one clear total gets one follow-up call asking for it (after the cooldown); its answer becomes the quote", async () => {
    const { engine, repo, clock, texts, calls } = demoEngine({ notifyPhone: null });
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Mission Eats", phone: "+14155550104" }] });
    await engine.advanceJob(deal.job_id);
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "local: Hi, I'm an AI assistant calling on behalf of a customer.\nremote: We can do it, I'll have to check the price and get back to you." });
    await engine.advanceJob(deal.job_id);
    expect(texts.filter((x) => x.to === "+14155550104")).toHaveLength(0);
    clock.advance(3 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    expect((calls[1] as { reason?: string }).reason).toMatch(/AI assistant calling on behalf of a customer/);
    expect((calls[1] as { reason?: string }).reason).toMatch(/all-in total/);

    expect((await engine.ingestCall({ callId: "call_2", outcome: "completed", transcript: "local: Following up.\nremote: $900 total all-in, delivered, $100 deposit" })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes.find((q) => q.business === "Mission Eats")).toMatchObject({ channel: "phone", total_usd: 900 });
    // Asked once only, and never by text.
    clock.advance(3 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    expect((await repo.listMessages(deal.job_id)).filter((m) => m.provider_email_id?.startsWith("sms:"))).toHaveLength(0);
  });
});

describe("texting a business over SMS (no iMessage port)", () => {
  it("the RFQ, the reply and the quote go by SMS on the text channel; email and the call are unaffected", async () => {
    const { engine, texts, emails } = demoEngine({ notifyPhone: null });
    const deal = await engine.deal({ request, budget_usd, businesses: [
      { name: "Harbor Table", email: "harbor@inkboxmail.test" },
      { name: "Golden Grill", phone: "+14085550123", channel: "imessage" },
    ] });
    expect(deal.contacted.map((c) => [c.business, c.channel])).toEqual(expect.arrayContaining([["Harbor Table", "email"], ["Golden Grill", "imessage"]]));
    expect(emails).toHaveLength(1);
    const rfq = texts.find((x) => x.to === "+14085550123")!;
    expect(rfq.text).toMatch(/^Hi Golden Grill, I'm an AI assistant for a customer\..*(Ref )?HG-[A-Z0-9]+$/);
    expect(rfq.text).not.toMatch(/Haggle/);

    const r = await engine.ingestText({ messageId: "sms_in_g1", from: "+14085550123", text: "We can do $1,020 total all-in, delivered, $100 deposit", inbound: true });
    expect(r).toMatchObject({ jobId: deal.job_id, outcome: "stored" });
    await engine.advanceJob(deal.job_id);
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes.find((q) => q.business === "Golden Grill")).toMatchObject({ channel: "imessage", total_usd: 1020 });
  });

  it("one number as the text business and the update recipient: a reply to the business's follow-up still reaches the business", async () => {
    const ME = "+14155550104";
    const { engine, texts, calls } = demoEngine({ notifyPhone: ME });
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: ME, channel: "imessage" }] });
    // A per-person price, no stated total: an update to the human AND a follow-up text to the business, same number.
    expect((await engine.ingestText({ messageId: "sms_in_me1", from: ME, text: "We'd do $22 per person, delivered", inbound: true })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    const toMe = texts.filter((x) => x.to === ME).map((x) => x.text);
    expect(toMe.some((t) => /^Thanks! AI assistant for a customer again\..*exact all-in total/.test(t))).toBe(true);
    expect(toMe.some((t) => /Golden Grill quoted \$880 by text/.test(t))).toBe(true);
    const r = await engine.ingestText({ messageId: "sms_in_me2", from: ME, text: "$880 total all-in, delivered, $200 deposit", inbound: true });
    expect(r.outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    expect((await engine.getQuotes(deal.job_id)).quotes[0]).toMatchObject({ business: "Golden Grill", total_usd: 880 });
    expect(calls).toHaveLength(0); // a text business is never phoned
  });
});

describe("preferences are soft (budget, requirements); only unsafe quotes are refused", () => {
  it("every quote over budget: the cheapest is recommended, the others are negotiated, and the human can approve any of them", async () => {
    const { engine, repo, clock, emails } = demoEngine({ notifyPhone: null });
    const deal = await engine.deal({ request, budget_usd: 1000, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }] });
    const reply = async (name: string, n: number, bodyText: string) => {
      const b = (await repo.getBusinesses(deal.job_id)).find((x) => x.name === name)!;
      await engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `t${n}`, messageId: `<in_${n}@x>`, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: b.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
    };
    await reply("Harbor Table", 1, "$1,150 total, 12 vegetarian, delivered, $200 deposit.");
    await reply("Sunset Kitchen", 2, "$1,300 total, 12 vegetarian, delivered, $250 deposit.");
    for (let i = 0; i < 4; i++) { clock.advance(31 * 60_000); await engine.advanceJob(deal.job_id); }
    const board = await engine.getQuotes(deal.job_id);
    const by = (n: string) => board.quotes.find((q) => q.business === n)!;
    expect(board.recommended_quote_id).toBe(by("Harbor Table").quote_id);
    expect(board.rejected).toEqual([]);
    expect(by("Sunset Kitchen")).toMatchObject({ eligible: true });
    expect(by("Sunset Kitchen").flags).toContain("over_budget");
    // Negotiation: Sunset is asked to match Harbor's real, over-budget $1,150.
    expect(board.negotiation.map((n) => [n.business, n.target_total_usd])).toEqual([["Sunset Kitchen", 1150]]);
    expect(emails.some((m) => m.to === "sunset@inkboxmail.test" && /another quote of \$1,150\.00 total/.test(m.bodyText))).toBe(true);
    // The human can approve the over-budget quote they prefer; the budget is a caveat on the approval.
    const a = await engine.requestApproval(deal.job_id, by("Sunset Kitchen").quote_id, "view");
    expect(a).toMatchObject({ status: "pending", payment_cents: 25_000 });
  });
});

// ── Regression: "i stopped getting text updates to my phone" ──────────────────────────────────
// Live cause (deployment #26, Inkbox listTexts): one text per quote (plus repeats of the same text)
// used up Inkbox's 10-texts-without-a-reply allowance in five minutes; every later text was refused
// (422 message_blocked_spam_filter / unanswered_limit) and only logged, so the human saw nothing.
const FLEET = ["Harbor Table", "Sunset Kitchen", "Bay Catering", "Golden Grill", "QuickQuote Deli", "Mission Eats", "Le Petit Four", "Taqueria Uno"].map((name, i) => ({ name, email: `b${i}@inkboxmail.test` }));

async function replyFrom(engine: HaggleEngine, repo: InMemoryRepository, jobId: string, name: string, n: number, bodyText: string) {
  const b = (await repo.getBusinesses(jobId)).find((x) => x.name === name)!;
  await engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `t${n}`, messageId: `<in_${n}@x>`, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: b.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
  await engine.advanceJob(jobId);
}

describe("text budget (Inkbox pauses a number after 10 texts with no reply)", () => {
  it("routine updates stop early, keeping texts for what needs the human; one text asks for a reply; the pause shows on the deal", async () => {
    const ink = inkboxLikeSms();
    const { engine, repo, logs } = demoEngine({ smsPort: ink.port });
    const deal = await engine.deal({ request, budget_usd, businesses: FLEET });
    for (let i = 0; i < 7; i++) await replyFrom(engine, repo, deal.job_id, FLEET[i]!.name, i + 1, `$${1100 + i * 10} total, 12 vegetarian, delivered. $300 deposit.`);
    const human = () => ink.sent.filter((x) => x.to === HUMAN);
    expect(human().filter((x) => /quoted \$/.test(x.text))).toHaveLength(5);
    expect(human().filter((x) => /Reply RESUME/.test(x.text))).toHaveLength(1);
    expect(ink.refused).toHaveLength(0);
    // A business question still reaches the human: the budget kept texts for it.
    await replyFrom(engine, repo, deal.job_id, "Taqueria Uno", 8, "Before I quote: should we stay to set up and serve, or is a drop-off fine?");
    expect(human().at(-1)!.text).toMatch(/Taqueria Uno asks/);
    expect(ink.refused).toHaveLength(0);
    // Visible on the deal (wait_for_update) and logged with the reason, not silent.
    expect((await repo.listEvents(deal.job_id)).filter((e) => e.type === "reply" && /text updates paused/i.test(String(e.data.summary)))).toHaveLength(1);
    expect(logs.some((l) => l.event === "notify_held" && l.data.reason === "routine_text_budget")).toBe(true);
    // The human replies RESUME: not an answer to the business, and routine updates flow again.
    ink.replied(HUMAN);
    expect((await engine.ingestText({ messageId: "in_resume", from: HUMAN, text: "RESUME", inbound: true })).outcome).toBe("texts_resumed");
    expect((await repo.listQuestions(deal.job_id)).find((q) => q.status === "pending")).toBeTruthy();
    await replyFrom(engine, repo, deal.job_id, "Le Petit Four", 9, "Revised: $1,050 total, 12 vegetarian, delivered. $300 deposit.");
    expect(human().at(-1)!.text).toMatch(/Le Petit Four quoted \$1,050/);
  });

  it("a number Inkbox already blocks (texts from before a redeploy): one refused try, logged with the reason and shown on the deal; the human's reply re-sends what they missed", async () => {
    const ink = inkboxLikeSms();
    ink.seed(HUMAN, 10);
    const { engine, repo, clock, logs } = demoEngine({ smsPort: ink.port });
    const deal = await engine.deal({ request, budget_usd, businesses: FLEET.slice(0, 2) });
    await replyFrom(engine, repo, deal.job_id, "Harbor Table", 1, "$1,150 total, 12 vegetarian, delivered. $345 deposit.");
    expect(ink.refused).toHaveLength(1);
    expect(logs.find((l) => l.event === "notify_blocked")?.data).toMatchObject({ job_id: deal.job_id, reason: "unanswered_limit" });
    await replyFrom(engine, repo, deal.job_id, "Sunset Kitchen", 2, "$1,250 total, 12 vegetarian, delivered. $300 deposit.");
    for (let i = 0; i < 3; i++) { clock.advance(31 * 60_000); await engine.advanceJob(deal.job_id); }
    expect(ink.refused).toHaveLength(1); // no hammering a blocked number
    expect((await repo.listEvents(deal.job_id)).filter((e) => e.type === "reply" && /texts to you are paused/i.test(String(e.data.summary)))).toHaveLength(1);
    // The human texts back (Inkbox lifts the block): the missed "quotes are in" text is sent.
    ink.replied(HUMAN);
    expect((await engine.ingestText({ messageId: "in_back", from: HUMAN, text: "hello?", inbound: true })).outcome).toBe("no_open_question");
    expect(ink.sent.filter((x) => x.to === HUMAN).map((x) => x.text)).toEqual([expect.stringMatching(/quotes for lunch catering are in\. Best: Harbor Table/)]);
  });

  it("the same update is never texted twice (a re-read or an unchanged revision)", async () => {
    const { engine, repo, texts } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: FLEET.slice(0, 2) });
    await replyFrom(engine, repo, deal.job_id, "Harbor Table", 1, "$1,150 total, 12 vegetarian, delivered. $345 deposit.");
    await replyFrom(engine, repo, deal.job_id, "Harbor Table", 2, "$1,150 total, 12 vegetarian, delivered. $345 deposit.");
    expect(texts.filter((x) => /Harbor Table quoted \$1,150/.test(x.text))).toHaveLength(1);
  });

  it("inkboxSms counts the texts a number hasn't answered yet (so a restart knows the budget)", async () => {
    const at = (m: number) => new Date(Date.UTC(2026, 9, 18, 5, m));
    const listTexts = async () => [
      { direction: "outbound", remotePhoneNumber: HUMAN, deliveryStatus: "delivered", createdAt: at(9) },
      { direction: "outbound", remotePhoneNumber: HUMAN, deliveryStatus: "blocked_spam_filter", createdAt: at(8) },
      { direction: "outbound", remotePhoneNumber: "+14085550123", deliveryStatus: "delivered", createdAt: at(7) },
      { direction: "outbound", remotePhoneNumber: HUMAN, deliveryStatus: "delivered", createdAt: at(6) },
      { direction: "inbound", remotePhoneNumber: HUMAN, deliveryStatus: null, createdAt: at(5) },
      { direction: "outbound", remotePhoneNumber: HUMAN, deliveryStatus: "delivered", createdAt: at(4) },
    ];
    const port = inkboxSms({ sendText: async () => ({ id: "t" }), listTexts } as never);
    expect(await port.unanswered!(HUMAN)).toBe(2);
    expect(await port.unanswered!("+14085550123")).toBe(1);
  });
});

// ── "the only way it lets me approve is by clicking the button" ───────────────────────────────
const untrusted = () => ({ trusted: false as const, retryable: false as const, reason: "unverified-external-sender" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

async function quoted(opts: Parameters<typeof demoEngine>[0] = {}) {
  const env = demoEngine(opts);
  const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }] });
  await emailReply(env.engine, env.repo, deal.job_id, 1, "Happy to help: $1,150 total, 12 vegetarian, delivered. $345 deposit.");
  const q = (await env.engine.getQuotes(deal.job_id)).quotes.find((x) => x.business === "Harbor Table")!;
  return { ...env, jobId: deal.job_id, quoteId: q.quote_id };
}

describe("approval by text (SMS)", () => {
  it("texts the human the exact approval with a code; YES <code> from that number approves (once)", async () => {
    const { engine, repo, texts, jobId, quoteId } = await quoted();
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    const ask = texts.at(-1)!;
    expect(ask.to).toBe(HUMAN);
    expect(ask.text).toMatch(new RegExp(`^Haggle: Approve \\$345 deposit to Harbor Table for lunch catering \\(total \\$1,150\\)\\? Reply YES ${a.code} or NO ${a.code}\\.`));
    expect(await engine.approvalOffers(a.id)).toMatchObject({ text: true, email: false });
    expect(await engine.ingestText({ messageId: "sms_yes", from: HUMAN, text: `yes ${a.code}`, inbound: true })).toMatchObject({ jobId, outcome: "approved" });
    expect(await repo.getApproval(a.id)).toMatchObject({ status: "approved", approver: HUMAN });
    expect((await engine.ingestText({ messageId: "sms_yes", from: HUMAN, text: `yes ${a.code}`, inbound: true })).outcome).toBe("duplicate");
  });

  it("only the human's number decides: another number can't, wrong codes count and lock after 5", async () => {
    const { engine, repo, jobId, quoteId } = await quoted();
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    expect((await engine.ingestText({ messageId: "x1", from: "+14155550999", text: `YES ${a.code}`, inbound: true })).outcome).toBe("unknown_sender");
    const wrong = a.code === "0000" ? "1111" : "0000";
    for (let i = 0; i < 4; i++) expect((await engine.ingestText({ messageId: `w${i}`, from: HUMAN, text: `YES ${wrong}`, inbound: true })).outcome).toBe("wrong_code");
    expect((await engine.ingestText({ messageId: "w5", from: HUMAN, text: `YES ${wrong}`, inbound: true })).outcome).toBe("approval_locked");
    expect((await repo.getApproval(a.id))!.status).toBe("locked");
  });

  it("NO <code> declines; a sentence starting with yes still answers the business's question", async () => {
    const { engine, repo, jobId, quoteId } = await quoted();
    const sunset = (await repo.getBusinesses(jobId)).find((b) => b.name === "Sunset Kitchen")!;
    await engine.ingest({ providerEventId: "eq", eventType: "message.received", providerEmailId: "in_q", threadId: "tq", messageId: "<in_q@x>", inReplyTo: [sunset.rfq_message_id!], references: [sunset.rfq_message_id!], from: sunset.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "Before I quote: is a drop-off fine?", attachments: [], attachmentsDownloadUrl: null }, trusted);
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    expect((await engine.ingestText({ messageId: "s1", from: HUMAN, text: "Yes, drop-off is fine.", inbound: true })).outcome).toBe("answered");
    expect((await repo.getApproval(a.id))!.status).toBe("pending");
    expect((await engine.ingestText({ messageId: "s2", from: HUMAN, text: `No ${a.code}`, inbound: true })).outcome).toBe("declined");
    expect((await repo.getApproval(a.id))!.status).toBe("declined");
  });

  it("a text-only human (no card, no form): the approval goes by SMS when iMessage is off", async () => {
    const { engine, texts, jobId, quoteId } = await quoted();
    const a = await engine.requestApproval(jobId, quoteId, "imessage");
    expect(texts.at(-1)!.text).toMatch(new RegExp(`Reply YES ${a.code} or NO ${a.code}`));
    expect(await engine.ingestText({ messageId: "y", from: HUMAN, text: `Y ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
  });

  it("no SMS or no number to text: a text approval is refused with a fix", async () => {
    const { engine, jobId, quoteId } = await quoted({ notifyPhone: null });
    await expect(engine.requestApproval(jobId, quoteId, "imessage")).rejects.toMatchObject({ code: "no_imessage_approver" });
    expect(await engine.approvalReach(jobId)).toEqual({ text: false, email: false });
  });

  // Live 2026-10-18: the card approved first; "YES 3845" arrived 12 s later and was sent to Sunset Kitchen as an answer.
  it("YES <code> after the card already approved is never sent to a business; the human is told it's done", async () => {
    const { engine, repo, texts, emails, jobId, quoteId } = await quoted();
    const sunset = (await repo.getBusinesses(jobId)).find((b) => b.name === "Sunset Kitchen")!;
    await engine.ingest({ providerEventId: "eq", eventType: "message.received", providerEmailId: "in_q", threadId: "tq", messageId: "<in_q@x>", inReplyTo: [sunset.rfq_message_id!], references: [sunset.rfq_message_id!], from: sunset.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "Do you need plates, cutlery and napkins, or just the food?", attachments: [], attachmentsDownloadUrl: null }, trusted);
    await engine.advanceJob(jobId);
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    expect(await engine.decideApproval(a.id, "approve", "view", "human (approval view)")).toBe(true);
    const sentBefore = emails.length;
    expect(await engine.ingestText({ messageId: "late_yes", from: HUMAN, text: `YES ${a.code}`, inbound: true })).toMatchObject({ jobId, outcome: "approval_already_decided" });
    expect(emails.length).toBe(sentBefore); // nothing went to Sunset Kitchen
    expect((await repo.listQuestions(jobId)).every((q) => q.status === "pending")).toBe(true);
    // Payments are off in this engine (disabled x402 payer): the reply says the payment didn't go through.
    expect(texts.at(-1)).toMatchObject({ to: HUMAN, text: expect.stringMatching(/approved on the card at .*didn't go through/) });
    // Redelivery of the same webhook: handled once.
    expect((await engine.ingestText({ messageId: "late_yes", from: HUMAN, text: `YES ${a.code}`, inbound: true })).outcome).toBe("duplicate");
  });

  it("a coded YES/NO that matches no approval is never sent to a business", async () => {
    const { engine, repo, emails, jobId } = await quoted();
    const sunset = (await repo.getBusinesses(jobId)).find((b) => b.name === "Sunset Kitchen")!;
    await engine.ingest({ providerEventId: "eq2", eventType: "message.received", providerEmailId: "in_q2", threadId: "tq2", messageId: "<in_q2@x>", inReplyTo: [sunset.rfq_message_id!], references: [sunset.rfq_message_id!], from: sunset.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "Is a drop-off fine?", attachments: [], attachmentsDownloadUrl: null }, trusted);
    await engine.advanceJob(jobId);
    const sentBefore = emails.length;
    expect((await engine.ingestText({ messageId: "stray", from: HUMAN, text: "YES 4821", inbound: true })).outcome).toBe("no_matching_approval");
    expect(emails.length).toBe(sentBefore);
  });

  it("approving by text charges the payment straight away (Stripe test mode) and texts the human", async () => {
    const stripe = simulatedStripe();
    const { engine, repo, texts, jobId, quoteId } = await quoted({ stripe });
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    expect(await engine.ingestText({ messageId: "pay_yes", from: HUMAN, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approved" });
    expect(stripe.charges.map((c) => c.amountCents)).toEqual([34_500]);
    expect((await repo.getJob(jobId))!.state).toBe("paid");
    expect(texts.at(-1)).toMatchObject({ to: HUMAN, text: expect.stringMatching(/Paid \$345 to Harbor Table/) });
    // The agent calling pay afterwards changes nothing (one charge).
    await engine.pay(jobId, quoteId);
    expect(stripe.charges).toHaveLength(1);
  });

  // Live 2026-10-17 (job_c78295b3287a42cd8974): the card approved at 6:45:10, the human's YES at 6:45:19 got
  // "nothing more to do", and the job sat in paying until the model called pay at 6:46:35.
  it("approving on the card charges at once (no Pay step); a late YES <code> is told it's paid", async () => {
    const stripe = simulatedStripe();
    const { engine, repo, texts, emails, jobId, quoteId } = await quoted({ stripe });
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    expect((await engine.approveWithViewCode(a.id, a.code)).status).toBe("used");
    expect(stripe.charges.map((c) => c.amountCents)).toEqual([34_500]);
    expect((await repo.getJob(jobId))!.state).toBe("paid");
    expect(texts.at(-1)).toMatchObject({ to: HUMAN, text: expect.stringMatching(/Paid \$345 to Harbor Table/) });
    const sentBefore = emails.length;
    expect(await engine.ingestText({ messageId: "late_yes_paid", from: HUMAN, text: `YES ${a.code}`, inbound: true })).toMatchObject({ jobId, outcome: "approval_already_decided" });
    expect(emails.length).toBe(sentBefore);
    expect(texts.at(-1)!.text).toMatch(/already approved on the card at \d{1,2}:\d{2}\s?[AP]M and paid \$345 to Harbor Table/);
    // The agent calling pay afterwards is harmless: still one charge.
    expect(await engine.pay(jobId, quoteId)).toMatchObject({ status: "settled" });
    expect(stripe.charges).toHaveLength(1);
  });

  it("approved on the card but the charge is still retrying: a late YES says it's paying now, then that it paid", async () => {
    const charges: { amountCents: number; idempotencyKey: string }[] = [];
    const script = [{ ok: false as const, reason: "stripe_unreachable", retryable: true }, { ok: false as const, reason: "stripe_http_503", retryable: true }];
    const flaky: StripePort = { simulated: true, async charge(r) { charges.push(r); return script.shift() ?? { ok: true, paymentIntentId: "pi_DEMOlate" }; } };
    const { engine, repo, texts, jobId, quoteId } = await quoted({ stripe: flaky });
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    await engine.approveWithViewCode(a.id, a.code);
    expect((await repo.getPaymentForJob(jobId))!.status).toBe("charging");
    const before = texts.length;
    expect(await engine.ingestText({ messageId: "late_yes_charging", from: HUMAN, text: `YES ${a.code}`, inbound: true })).toMatchObject({ outcome: "approval_already_decided" });
    const after = texts.slice(before).map((x) => x.text);
    expect(after[0]).toMatch(/approved on the card at \d{1,2}:\d{2}\s?[AP]M; paying \$345 to Harbor Table now/);
    expect(after.at(-1)).toMatch(/Paid \$345 to Harbor Table/);
    expect(after.join(" ")).not.toMatch(/nothing (else|more) to do/i);
    expect((await repo.getJob(jobId))!.state).toBe("paid");
    expect(new Set(charges.map((c) => c.idempotencyKey))).toEqual(new Set([`haggle-pay-${a.id}`])); // one PaymentIntent
  });

  it("a declined charge after approval is told to the human, never 'nothing to do'", async () => {
    const stripe = simulatedStripe({ decline: "card_declined" });
    const { engine, texts, jobId, quoteId } = await quoted({ stripe });
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    await engine.approveWithViewCode(a.id, a.code);
    expect(texts.some((x) => /payment to Harbor Table didn't go through: card_declined/.test(x.text))).toBe(true);
    await engine.ingestText({ messageId: "late_yes_declined", from: HUMAN, text: `YES ${a.code}`, inbound: true });
    expect(texts.at(-1)!.text).toMatch(/approved on the card at .* but the \$345 payment to Harbor Table didn't go through/);
    expect(stripe.charges).toHaveLength(1);
  });

  it("a revised quote while the human is deciding voids the approval: a late tap or YES charges nothing", async () => {
    const stripe = simulatedStripe();
    const { engine, repo, jobId, quoteId } = await quoted({ stripe });
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    await emailReply(engine, repo, jobId, 2, "Correction: $1,250 total, 12 vegetarian, delivered. $375 deposit.");
    expect((await repo.getApproval(a.id))!.status).toBe("expired");
    expect((await engine.approveWithViewCode(a.id, a.code)).status).toBe("expired");
    await engine.ingestText({ messageId: "late_yes_revised", from: HUMAN, text: `YES ${a.code}`, inbound: true });
    expect(stripe.charges).toHaveLength(0);
    await expect(engine.pay(jobId, quoteId)).rejects.toBeTruthy();
    expect(stripe.charges).toHaveLength(0);
  });

  it("a blocked number: the approval text is held and sent when the human texts back", async () => {
    const ink = inkboxLikeSms();
    const { engine, repo, jobId, quoteId } = await quoted({ smsPort: ink.port });
    ink.seed(HUMAN, 10);
    const a = await engine.requestApproval(jobId, quoteId, "view", undefined, { text: true });
    expect(await engine.approvalOffers(a.id)).toMatchObject({ text: false });
    expect((await repo.listEvents(jobId)).some((e) => e.type === "approval_text_failed" && e.data.reason === "unanswered_limit")).toBe(true);
    ink.replied(HUMAN);
    await engine.ingestText({ messageId: "hi", from: HUMAN, text: "hi", inbound: true });
    expect(ink.sent.at(-1)!.text).toMatch(new RegExp(`Reply YES ${a.code}`));
    expect(await engine.approvalOffers(a.id)).toMatchObject({ text: true });
  });
});

describe("the human's texted answers", () => {
  it("'answer <business> ...' goes to that business without the instruction, and covers its duplicate questions", async () => {
    const { engine, repo, emails, jobId } = await quoted();
    const sunset = (await repo.getBusinesses(jobId)).find((b) => b.name === "Sunset Kitchen")!;
    for (const n of [1, 2]) await engine.ingest({ providerEventId: `dq${n}`, eventType: "message.received", providerEmailId: `in_dq${n}`, threadId: `tdq${n}`, messageId: `<in_dq${n}@x>`, inReplyTo: [sunset.rfq_message_id!], references: [sunset.rfq_message_id!], from: sunset.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "Do you need plates, cutlery and napkins, or just the food?", attachments: [], attachmentsDownloadUrl: null }, trusted);
    await engine.advanceJob(jobId);
    expect((await repo.listQuestions(jobId)).filter((q) => q.status === "pending")).toHaveLength(2);
    const before = emails.length;
    expect((await engine.ingestText({ messageId: "ans", from: HUMAN, text: "answer sunset kitchen with no plates cutlery or napkins - just food", inbound: true })).outcome).toBe("answered");
    const sent = emails.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "sunset@inkboxmail.test" });
    expect(sent[0]!.bodyText).toContain("no plates cutlery or napkins - just food");
    expect(sent[0]!.bodyText).not.toMatch(/answer sunset kitchen/i);
    expect((await repo.listQuestions(jobId)).every((q) => q.status === "answered")).toBe(true);
  });
});

describe("approval by email", () => {
  async function emailed(config: Partial<EngineConfig>) {
    const env = await quoted({ config });
    await env.engine.updateSettings({ approver_email: "boss@gmail.test" });
    expect(await env.engine.approvalReach(env.jobId)).toEqual({ text: true, email: true });
    const a = await env.engine.requestApproval(env.jobId, env.quoteId, "view", undefined, { email: true });
    const outId = (await env.repo.getApproval(a.id))!.outbound_message_id!;
    const reply = (n: number, from: string, bodyText: string) => env.engine.ingest({ providerEventId: `ea${n}`, eventType: "message.received", providerEmailId: `ain_${n}`, threadId: "ta", messageId: `<ain_${n}@x>`, inReplyTo: [outId], references: [outId], from, to: ["haggle@inkboxmail.test"], subject: "Re: approve", bodyText, attachments: [], attachmentsDownloadUrl: null }, untrusted);
    return { ...env, a, reply };
  }

  it("emails the settings approver; only that address with APPROVE <code> approves (code proof; Inkbox can't DKIM-check outside mail)", async () => {
    const { engine, repo, emails, a, reply } = await emailed({ emailApprovalByCode: true });
    const mail = emails.at(-1)!;
    expect(mail.to).toBe("boss@gmail.test");
    expect(mail.subject).toMatch(/Approve \$345 deposit to Harbor Table/);
    expect(mail.bodyText).toMatch(new RegExp(`reply with: APPROVE ${a.code}`));
    expect(mail.bodyText).not.toMatch(/USDC|base-sepolia|undefined/);
    expect(await engine.approvalOffers(a.id)).toMatchObject({ email: true });
    await reply(1, "mallory@evil.test", `APPROVE ${a.code}`);
    await reply(2, "boss@gmail.test", "sounds good to me");
    expect((await repo.getApproval(a.id))!.status).toBe("pending");
    expect((await reply(3, "boss@gmail.test", `APPROVE ${a.code}\n\nOn Mon, Haggle wrote:\n> APPROVE ${a.code}`)).outcome).toBe("approval:approve");
    expect(await repo.getApproval(a.id)).toMatchObject({ status: "approved", channel: "email", approver: "boss@gmail.test" });
  });

  it("a wrong emailed code counts toward the lockout", async () => {
    const { repo, a, reply } = await emailed({ emailApprovalByCode: true });
    await reply(1, "boss@gmail.test", `APPROVE ${a.code === "0000" ? "1111" : "0000"}`);
    expect((await repo.getApproval(a.id))!).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("with code proof off, an unauthenticated sender can't approve by email (strict rule)", async () => {
    const { repo, a, reply } = await emailed({});
    await reply(1, "boss@gmail.test", `APPROVE ${a.code}`);
    expect((await repo.getApproval(a.id))!.status).toBe("pending");
  });
});
