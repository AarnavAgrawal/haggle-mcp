// Every message to a business after first contact stays on the channel it was first contacted on
// (email, a Voice AI call, a text, A2A), unless the agent explicitly picks another one; and every
// message introduces the sender as an AI assistant acting for the customer, never as "Haggle".
// Real engine, fake Inkbox ports; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type SmsPort } from "../src/index.ts";
import { buildRfqEmail } from "../src/outbound/rfq.ts";

// Reads figures and questions out of free text, like the Claude extractor does live.
const textExtractor = {
  async extract(i: { bodyText: string }) {
    // A text reply is read with our last text for context: only the business's own words count here.
    const t = (i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText).split("\n").filter((l) => !/^\s*(local|agent)\s*:/i.test(l)).join("\n");
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[- ]in)/i);
    const perHead = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:a|per) (?:head|person)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const questions = t.split(/(?<=\?)/).map((s) => s.trim()).filter((s) => s.endsWith("?"));
    const sources = [
      ...(total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []),
      ...(perHead !== null ? [{ field: "price_per_head" as const, source: "text", excerpt: `$${perHead} per person` }] : []),
    ];
    return {
      available: true, price_per_head_usd: perHead, headcount: perHead !== null ? 40 : null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: /deliver/i.test(t) ? true : null,
      tax_usd: null, tax_included: true, total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: total === null && perHead === null ? questions : [], payment_request: "none" as const, instructions_to_agent: false,
      sources, missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

function demoEngine(config: Record<string, unknown> = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; bodyText: string; idempotencyKey: string }[] = [];
  const texts: { to: string; text: string; idempotencyKey: string }[] = [];
  const calls: { toNumber: string; reason: string; idempotencyKey: string }[] = [];
  const sms: SmsPort = { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } };
  const repo = new InMemoryRepository({ now: clock.now });
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
    sms,
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 50_000, maxRounds: 2, ...config,
    },
  });
  return { engine, repo, clock, emails, texts, calls };
}

const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const { budget_usd, ...request } = GOLDEN_REQUEST;
const GRILL = "+14085550123";
const MISSION = "+14155550104";

async function emailReply(engine: HaggleEngine, repo: InMemoryRepository, jobId: string, name: string, n: number, bodyText: string) {
  const b = (await repo.getBusinesses(jobId)).find((x) => x.name === name)!;
  await engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `t${n}`, messageId: `<in_${n}@x>`, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: b.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
  await engine.advanceJob(jobId);
}

describe("follow-ups stay on the channel the business was first contacted on", () => {
  it("a text business is followed up by text, never by email or a call, even when it has an email address", async () => {
    const { engine, repo, emails, texts, calls } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: GRILL, email: "grill@inkboxmail.test", channel: "imessage" }] });
    expect(deal.contacted).toEqual([expect.objectContaining({ business: "Golden Grill", channel: "imessage" })]);
    expect(texts.filter((x) => x.to === GRILL)).toHaveLength(1);
    // Per-person price with no stated total and delivery unstated (so Haggle can't work out the all-in
    // total, decision 47): ask for the exact total AND the missing requirement, both by text.
    expect((await engine.ingestText({ messageId: "in_g1", from: GRILL, text: "can do $13 per person, 8% tax on top", inbound: true })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    const toGrill = texts.filter((x) => x.to === GRILL);
    expect(toGrill.length).toBeGreaterThanOrEqual(2);
    expect(toGrill.some((x) => /exact all-in total/.test(x.text))).toBe(true);
    for (const x of toGrill) {
      expect(x.text).not.toMatch(/HG-/); // no reference code to the business
      expect(x.text).not.toMatch(/Haggle/);
    }
    expect(emails).toHaveLength(0);
    expect(calls).toHaveLength(0);
    const out = (await repo.listMessages(deal.job_id)).filter((m) => m.direction === "out");
    expect(out.every((m) => m.channel === "imessage")).toBe(true);
  });

  it("a missing requirement is asked by text for a text business (the 'Asked Golden Grill for ...' follow-up)", async () => {
    const { engine, repo, emails, texts, calls } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }] });
    // A stated total, but nothing about delivery: one follow-up for the missing hard requirement.
    await engine.ingestText({ messageId: "in_g2", from: GRILL, text: "$1,020 total all-in, $100 deposit", inbound: true });
    await engine.advanceJob(deal.job_id);
    const missing = (await repo.listMessages(deal.job_id)).find((m) => m.idempotency_key?.endsWith(":missing"));
    expect(missing).toMatchObject({ direction: "out", kind: "followup", channel: "imessage" });
    expect(texts.at(-1)!.text).toMatch(/Delivery included/);
    expect(emails).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect((await engine.getQuotes(deal.job_id)).businesses[0]!.last_event).toMatch(/Asked Golden Grill for: Delivery included, any deposit and when it's due, your cancellation policy \(text\)/);
  });

  it("a phone business whose call left the total unclear gets a follow-up Voice AI call (after the cooldown), never a text", async () => {
    const { engine, repo, clock, texts, calls } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi, I'm an AI assistant.\nremote: We can do it, I'll have to check the price and get back to you." });
    await engine.advanceJob(deal.job_id);
    expect(texts.filter((x) => x.to === MISSION)).toHaveLength(0);
    expect(calls).toHaveLength(1); // the call just ended: the follow-up waits out the cooldown

    clock.advance(3 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ toNumber: MISSION, idempotencyKey: `followup:${deal.job_id}:${(await repo.getBusinesses(deal.job_id))[0]!.business_id}:1` });
    expect(calls[1]!.reason).toMatch(/AI assistant calling on behalf of a customer/);
    expect(calls[1]!.reason).toMatch(/all-in total/);
    expect(calls[1]!.reason).not.toMatch(/Haggle/);
    // The follow-up call's result is read like the first call (it was placed by us, to the pinned number).
    expect((await engine.ingestCall({ callId: "call_2", outcome: "completed", transcript: "agent: Following up.\nremote: $900 total all-in, delivered, $100 deposit." })).outcome).toBe("stored");
    await engine.advanceJob(deal.job_id);
    expect((await engine.getQuotes(deal.job_id)).quotes.find((q) => q.business === "Mission Eats")).toMatchObject({ channel: "phone", total_usd: 900 });
    // Asked once only; nothing was ever texted to the business.
    clock.advance(3 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    expect(texts.filter((x) => x.to === MISSION)).toHaveLength(0);
  });

  it("an email business is followed up by email even when it also has a phone", async () => {
    const { engine, repo, emails, texts, calls } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test", phone: "+14155550177" }] });
    await emailReply(engine, repo, deal.job_id, "Harbor Table", 1, "We'd do $26 per person, 12 vegetarian."); // delivery unstated: the total can't be worked out
    expect(emails).toHaveLength(2);
    expect(emails[1]!.bodyText).toMatch(/exact all-in total/);
    expect(texts).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("negotiation stays on the business's channel", () => {
  it("a counteroffer to a phone business is a short follow-up call citing only the real competing total", async () => {
    const { engine, repo, clock, emails, texts, calls } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", 1, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await engine.advanceJob(deal.job_id);
    await engine.advanceJob(deal.job_id);
    // Both quoted: the window closes and Mission Eats ($1,150) is countered with Harbor's real $1,000 once the cooldown allows.
    expect(calls).toHaveLength(1);
    clock.advance(3 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    const mission = (await repo.getBusinesses(deal.job_id)).find((b) => b.name === "Mission Eats")!;
    expect(calls[1]!.idempotencyKey).toBe(`counter:${deal.job_id}:${mission.business_id}:r2`);
    expect(calls[1]!.reason).toMatch(/\$1,000(\.00)? total/);
    expect(calls[1]!.reason).toMatch(/\$1,150(\.00)? total/);
    expect(calls[1]!.reason).not.toMatch(/Harbor/);
    expect(calls[1]!.reason).not.toMatch(/Haggle/);
    expect(calls[1]!.reason).toMatch(/Never invent, round down or exaggerate/);
    expect(texts.filter((x) => x.to === MISSION)).toHaveLength(0);
    expect(emails.filter((m) => /another quote/.test(m.bodyText))).toHaveLength(0); // Harbor is the best: not countered
    // Their answer on the call is a new round.
    await engine.ingestCall({ callId: "call_2", outcome: "completed", transcript: "agent: We have another quote of $1,000 total. Can you match it?\nremote: We can do $980 total all-in, 12 vegetarian, delivered, $100 deposit." });
    await engine.advanceJob(deal.job_id);
    const board = await engine.getQuotes(deal.job_id);
    expect(board.negotiation.find((n) => n.business === "Mission Eats")).toMatchObject({ target_total_usd: 1000 });
    expect(board.quotes.find((q) => q.business === "Mission Eats")).toMatchObject({ total_usd: 980 });
  });

  // Live 2026-10-18 (job_f067a617c25b4adf8a80): the counter call to Mission Eats was scheduled 2 min after
  // its quote call ended; the human chose on the board before it was placed and never knew it was pending.
  it("a counteroffer call right after the quote call waits 60 s (not the 2-minute cooldown), never under 30 s; the board shows when", async () => {
    const { engine, repo, clock, calls } = demoEngine({ callCooldownMs: 2 * 60_000 });
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", 1, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    const ended = Date.now();
    await engine.advanceJob(deal.job_id);
    let board = await engine.getQuotes(deal.job_id);
    expect(board.state).toBe("negotiating");
    const step = board.negotiation.find((n) => n.business === "Mission Eats")!;
    expect(step).toMatchObject({ channel: "phone", target_total_usd: 1000, from_total_usd: 1150, outcome_total_usd: null });
    const wait = Date.parse(step.scheduled_for!) - ended;
    expect(wait).toBeGreaterThanOrEqual(55_000);
    expect(wait).toBeLessThanOrEqual(65_000);
    clock.advance(30_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    clock.advance(35_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).toMatch(/^counter:/);
    board = await engine.getQuotes(deal.job_id);
    expect(board.negotiation.find((n) => n.business === "Mission Eats")!.scheduled_for).toBeUndefined(); // placed: no longer "scheduled"
  });

  it("the counter-call gap never drops under 30 s, and spacing stays off when the cooldown is 0 (mock fleet)", async () => {
    const { engine, repo, clock, calls } = demoEngine({ callCooldownMs: 2 * 60_000, counterCallGapMs: 5_000 });
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", 1, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await engine.advanceJob(deal.job_id);
    clock.advance(10_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    clock.advance(25_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);

    const mock = demoEngine({ callCooldownMs: 0 });
    const d2 = await mock.engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await mock.engine.advanceJob(d2.job_id);
    await emailReply(mock.engine, mock.repo, d2.job_id, "Harbor Table", 1, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await mock.engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await mock.engine.advanceJob(d2.job_id);
    expect(mock.calls).toHaveLength(2); // placed at once
  });

  it("demo speed (decision 49): minCallGapMs lowers the floor, so a counter call goes 5 s after the quote call", async () => {
    const { engine, repo, clock, calls } = demoEngine({ callCooldownMs: 5_000, counterCallGapMs: 5_000, minCallGapMs: 5_000 });
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", 1, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    clock.advance(6_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).toMatch(/^counter:/);
  });

  it("a counteroffer to a text business goes by text", async () => {
    const { engine, repo, emails, texts } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Golden Grill", phone: GRILL, email: "grill@inkboxmail.test", channel: "imessage" }] });
    await emailReply(engine, repo, deal.job_id, "Harbor Table", 1, "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await engine.ingestText({ messageId: "in_g3", from: GRILL, text: "$1,200 total all-in, delivered, $100 deposit", inbound: true });
    await engine.advanceJob(deal.job_id);
    await engine.advanceJob(deal.job_id);
    const counter = texts.find((x) => x.to === GRILL && /another quote/.test(x.text));
    expect(counter?.text).toMatch(/\$1,000\.00/);
    expect(emails.some((m) => m.to === "grill@inkboxmail.test")).toBe(false);
  });
});

describe("answers and the agent's messages stay on the business's channel unless the agent picks another", () => {
  it("answers a text business by text; send_message defaults to text and honours an explicit channel", async () => {
    const { engine, repo, emails, texts } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: GRILL, email: "grill@inkboxmail.test", channel: "imessage" }] });
    await engine.ingestText({ messageId: "in_g4", from: GRILL, text: "Before I quote: do you need plates?", inbound: true });
    await engine.advanceJob(deal.job_id);
    const q = (await repo.listQuestions(deal.job_id))[0]!;
    await engine.answerSeller(deal.job_id, q.id, "Yes, plates for 40 please.");
    expect(texts.at(-1)).toMatchObject({ to: GRILL, text: expect.stringMatching(/Yes, plates for 40 please\./) });
    expect(emails).toHaveLength(0);

    const b = (await repo.getBusinesses(deal.job_id))[0]!;
    expect(await engine.sendMessage(deal.job_id, b.business_id, { text: "Is delivery included?" })).toMatchObject({ channel: "imessage", sent: true });
    expect(texts.at(-1)!.text).toMatch(/Is delivery included\?/);
    expect(emails).toHaveLength(0);
    // Told otherwise: the agent explicitly asks for email.
    expect(await engine.sendMessage(deal.job_id, b.business_id, { text: "Could you also email a PDF menu?", channel: "email" })).toMatchObject({ channel: "email", sent: true });
    expect(emails.at(-1)).toMatchObject({ to: "grill@inkboxmail.test", bodyText: expect.stringMatching(/email a PDF menu/) });
  });

  it("answers a phone business with a short call (not a text or an email)", async () => {
    const { engine, repo, clock, emails, texts, calls } = demoEngine();
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Mission Eats", phone: MISSION, email: "mission@inkboxmail.test", channel: "phone" }] });
    await engine.advanceJob(deal.job_id);
    const first = calls.length;
    await engine.ingestCall({ callId: `call_${first}`, outcome: "completed", transcript: "agent: Hi.\nremote: Sure. Do you need plates and cutlery?" });
    await engine.advanceJob(deal.job_id);
    const q = (await repo.listQuestions(deal.job_id))[0]!;
    clock.advance(3 * 60_000);
    const r = await engine.answerSeller(deal.job_id, q.id, "Yes, plates and cutlery for 40.");
    expect(r).toMatchObject({ sent: true });
    expect(calls).toHaveLength(first + 1);
    expect(calls.at(-1)!.reason).toMatch(/Yes, plates and cutlery for 40\./);
    expect(calls.at(-1)!.reason).toMatch(/AI assistant calling on behalf of a customer/);
    expect(texts.filter((x) => x.to === MISSION)).toHaveLength(0);
    expect(emails.filter((m) => m.to === "mission@inkboxmail.test")).toHaveLength(0);
  });
});

describe("introduces itself as an AI assistant for the customer, never as Haggle", () => {
  it("the RFQ text, email and call name the customer when the deal gives one", async () => {
    const { engine, emails, texts, calls } = demoEngine();
    const withCustomer = { ...request, details: [{ label: "Customer", value: "Acme Labs" }] };
    await engine.deal({ request: withCustomer, budget_usd, businesses: [
      { name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Golden Grill", phone: GRILL, channel: "imessage" }, { name: "Mission Eats", phone: MISSION },
    ] });
    expect(emails[0]!.bodyText).toMatch(/I'm an AI assistant reaching out on behalf of Acme Labs/);
    expect(texts[0]!.text).toMatch(/^Hi Golden Grill, I'm an AI assistant for Acme Labs\..*Total \+ deposit\?$/);
    expect(texts[0]!.text.length).toBeLessThanOrEqual(159);
    expect(calls[0]!.reason).toMatch(/Hi, I'm an AI assistant calling on behalf of Acme Labs/);
    for (const s of [emails[0]!.bodyText, texts[0]!.text, calls[0]!.reason]) expect(s).not.toMatch(/Haggle/);
  });

  it("falls back to the configured customer name, then to 'a customer'", async () => {
    const named = demoEngine({ customerName: "Priya" });
    await named.engine.deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }] });
    expect(named.texts[0]!.text).toMatch(/I'm an AI assistant for Priya\./);
    const plain = demoEngine();
    await plain.engine.deal({ request, budget_usd, businesses: [{ name: "Golden Grill", phone: GRILL, channel: "imessage" }] });
    expect(plain.texts[0]!.text).toMatch(/I'm an AI assistant for a customer\./);
  });

  it("a long RFQ text is clipped in the middle, keeping the AI disclosure and the ask (no reference code)", () => {
    const job = { short_code: "ZQ9R", request: { ...request, what: "dinner catering with a very long description of everything", area: "Y Combinator HQ, 320 Pioneer Way, Mountain View, CA", details: [{ label: "Company", value: "Some Extremely Long Startup Name Incorporated" }] } } as never;
    const t = HaggleEngine.rfqIMessageText("Golden Grill and Catering Company", job);
    expect(t.length).toBeLessThanOrEqual(159);
    expect(t).toMatch(/I'm an AI assistant for /);
    expect(t).toMatch(/Total \+ deposit\?$/);
    expect(t).not.toMatch(/HG-/);
    expect(t).not.toMatch(/https?:|\d{3}[\s.-]\d{3}[\s.-]\d{4}/);
  });

  it("the RFQ email signs off as the customer's AI assistant", () => {
    const out = buildRfqEmail({ shortCode: "7F3K", businessName: "Bay Catering", what: "lunch catering", quantity: 40, date: "2026-10-22", location: "San Francisco, CA", requirements: [], replyBy: new Date("2026-10-17T21:30:00Z"), customer: "Acme Labs" });
    expect(out.bodyText).toMatch(/^Hi Bay Catering,\n\nI'm an AI assistant reaching out on behalf of Acme Labs\./);
    expect(out.bodyText.trim().split("\n").at(-1)).toBe("AI assistant for Acme Labs");
    expect(out.bodyText).not.toMatch(/Haggle/);
  });
});
