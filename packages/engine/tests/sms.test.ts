// SMS from the buyer identity's own number (Inkbox sendText): update texts to the human (new quote,
// a business question, a finished call, quotes ready), the human's reply answering the open
// question, and follow-ups to phone businesses whose call left the total unclear. Real engine, fake
// Inkbox ports; no network.
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type SmsPort } from "../src/index.ts";

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

function demoEngine(opts: { sms?: boolean; notifyPhone?: string | null } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; bodyText: string }[] = [];
  const texts: { to: string; text: string; idempotencyKey: string }[] = [];
  const calls: { toNumber: string }[] = [];
  const sms: SmsPort = { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } };
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: { async placeCall(r) { calls.push(r); return { callId: `call_${calls.length}` }; } },
    ...(opts.sms === false ? {} : { sms }),
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 50_000, maxRounds: 2, ...(opts.notifyPhone === null ? {} : { notifyPhone: opts.notifyPhone ?? HUMAN }),
    },
  });
  return { engine, repo, clock, emails, texts, calls };
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

describe("SMS follow-up to a phone business", () => {
  it("a call without one clear total gets one text asking for it; the texted reply becomes the quote", async () => {
    const { engine, repo, texts } = demoEngine({ notifyPhone: null });
    const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Mission Eats", phone: "+14155550104" }] });
    await engine.advanceJob(deal.job_id);
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "local: Hi, this is Haggle, an AI assistant.\nremote: We can do it, I'll have to check the price and get back to you." });
    await engine.advanceJob(deal.job_id);
    const followUp = texts.filter((x) => x.to === "+14155550104");
    expect(followUp).toHaveLength(1);
    expect(followUp[0]!.text).toMatch(/AI assistant/);
    expect(followUp[0]!.text).toMatch(/all-in total/);

    const r = await engine.ingestText({ messageId: "sms_in_2", from: "+14155550104", text: "$900 total all-in, delivered, $100 deposit", inbound: true });
    expect(r).toMatchObject({ jobId: deal.job_id, outcome: "stored" });
    await engine.advanceJob(deal.job_id);
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes.find((q) => q.business === "Mission Eats")).toMatchObject({ channel: "phone", total_usd: 900 });
    // Asked once only.
    await engine.advanceJob(deal.job_id);
    expect(texts.filter((x) => x.to === "+14155550104")).toHaveLength(1);
    expect((await repo.listMessages(deal.job_id)).filter((m) => m.provider_email_id?.startsWith("sms:"))).toHaveLength(1);
  });
});
