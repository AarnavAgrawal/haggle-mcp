// Negotiation on every channel, reproducing live job 7JF6 (2026-10-18): four email businesses, a
// phone business (Mission Eats, a Voice AI call) and a text business (Golden Grill, SMS). Real
// engine, fake Inkbox ports; no network.
//
// What went wrong live:
// - Golden Grill's clarification text (the exact total after Haggle's follow-up) was stored as
//   quote round 2, so the planner thought its negotiation round was used up: no counter text.
// - Mission Eats had the best safe price, so it was the cited basis and correctly got no counter
//   call, but nothing on the board said so.
// - The round waited 15 minutes for a slow email business with the board only saying "Negotiating".
import { describe, expect, it } from "vitest";
import { disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, StubBrain, type SmsPort } from "../src/index.ts";

const textExtractor = {
  async extract(i: { bodyText: string }) {
    const t = (i.bodyText.split("[The business's reply]:")[1] ?? i.bodyText).split("\n").filter((l) => !/^\s*(local|agent)\s*:/i.test(l)).join("\n");
    const money = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1]!.replace(/,/g, "")) : null; };
    const total = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:total|all[- ]in)/i);
    const perHead = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*(?:a|per) (?:head|person)/i);
    const deposit = money(/\$\s?([\d,]+(?:\.\d{2})?)\s*deposit/i);
    const sources = [
      ...(total !== null ? [{ field: "total" as const, source: "text", excerpt: `$${total} total` }] : []),
      ...(perHead !== null ? [{ field: "price_per_head" as const, source: "text", excerpt: `$${perHead} per person` }] : []),
    ];
    return {
      available: true, price_per_head_usd: perHead, headcount: perHead !== null ? 40 : null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: true,
      tax_usd: null, tax_included: !/plus tax/i.test(t), total_usd: total, deposit_usd: deposit, menu_items: [], dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 12 }],
      valid_until: null, questions: [], payment_request: "none" as const, instructions_to_agent: false,
      sources, missing_fields: total === null ? ["total"] : [], confidence: 0.9,
    };
  },
};

const HUMAN = "+14155550199";
const GRILL = "+14085550123";
const MISSION = "+14155550104";

function demoEngine(opts: { failCounterCalls?: number; config?: Record<string, unknown> } = {}) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const emails: { to: string; bodyText: string; idempotencyKey: string }[] = [];
  const texts: { to: string; text: string; idempotencyKey: string }[] = [];
  const calls: { toNumber: string; reason: string; idempotencyKey: string }[] = [];
  let failures = opts.failCounterCalls ?? 0;
  const sms: SmsPort = { async send(r) { texts.push(r); return { messageId: `sms_${texts.length}` }; } };
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor: textExtractor as never, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send(m) { emails.push(m); return { providerId: `em_${emails.length}`, status: "sent", idempotentReplay: false, messageId: `<em_${emails.length}@haggle.test>` }; } },
    phone: {
      async placeCall(r) {
        if (r.idempotencyKey.startsWith("counter:") && failures > 0) { failures--; throw new Error("503 hosted_agent_at_capacity"); }
        calls.push(r);
        return { callId: `call_${calls.length}` };
      },
    },
    sms,
    config: {
      mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000,
      globalPaymentCapCents: 500_000, maxRounds: 2, notifyPhone: HUMAN, ...opts.config,
    },
  });
  return { engine, repo, clock, emails, texts, calls };
}

const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const { budget_usd: _budget, ...request } = GOLDEN_REQUEST;
let n = 0;

async function emailReply(engine: HaggleEngine, repo: InMemoryRepository, jobId: string, name: string, bodyText: string) {
  const b = (await repo.getBusinesses(jobId)).find((x) => x.name === name)!;
  n++;
  await engine.ingest({ providerEventId: `e${n}`, eventType: "message.received", providerEmailId: `in_${n}`, threadId: `t_${name}`, messageId: `<in_${n}@x>`, inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], from: b.email!, to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText, attachments: [], attachmentsDownloadUrl: null }, trusted);
  await engine.advanceJob(jobId);
}

async function text(engine: HaggleEngine, jobId: string, from: string, body: string) {
  n++;
  await engine.ingestText({ messageId: `in_t${n}`, from, text: body, inbound: true });
  await engine.advanceJob(jobId);
}

const summaries = async (repo: InMemoryRepository, jobId: string) => (await repo.listEvents(jobId)).filter((e) => e.type === "reply").map((e) => String(e.data.summary));

describe("negotiation on every channel (live job 7JF6)", () => {
  it("a text business's clarification stays round 1, so it is countered by text; the cheapest phone business is the basis and is told why it gets no call", async () => {
    const { engine, repo, emails, texts, calls } = demoEngine();
    const deal = await engine.deal({
      request, budget_usd: 5000,
      businesses: [
        { name: "Golden Grill", phone: GRILL, channel: "imessage" },
        { name: "Harbor Table", email: "harbor@inkboxmail.test" },
        { name: "Mission Eats", phone: MISSION },
        { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" },
      ],
    });
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    // Golden Grill texts a per-person price plus tax at no stated rate (so Haggle can't work out the
    // all-in total, decision 47); Haggle asks once (by text) for the exact all-in total; it answers.
    await text(engine, deal.job_id, GRILL, "$30 per person plus tax and $50 delivery, $100 deposit");
    expect(texts.some((x) => x.to === GRILL && /exact all-in total/.test(x.text))).toBe(true);
    await text(engine, deal.job_id, GRILL, "yes $3,350 total all-in, $500 deposit");
    const grillQuote = (await repo.listQuotes(deal.job_id)).find((q) => q.status === "current" && q.total_cents === 335_000)!;
    expect(grillQuote.round).toBe(1); // a clarification, not a negotiation round
    await emailReply(engine, repo, deal.job_id, "Harbor Table", "$3,000 total all-in, 12 vegetarian, delivered, $1,050 deposit.");
    await emailReply(engine, repo, deal.job_id, "Sunset Kitchen", "$2,825 total all-in, delivered, $565 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,680 total all-in, 12 vegetarian, delivered, $250 deposit." });
    await engine.advanceJob(deal.job_id);

    let board = await engine.getQuotes(deal.job_id);
    expect(board.state).toBe("negotiating");
    // Everyone above Mission Eats' $1,680 is countered on its own channel.
    expect(emails.filter((m) => /another quote of \$1,680\.00/.test(m.bodyText)).map((m) => m.to).sort()).toEqual(["harbor@inkboxmail.test", "sunset@inkboxmail.test"]);
    const counterText = texts.find((x) => x.to === GRILL && /another quote/.test(x.text));
    expect(counterText?.text).toMatch(/\$1,680\.00 total/);
    expect(counterText?.text).toMatch(/AI assistant/);
    expect(counterText?.text).not.toMatch(/Mission|Haggle/);
    // Mission Eats is the basis: no counter call, and the board says why.
    expect(calls).toHaveLength(1);
    expect(await summaries(repo, deal.job_id)).toContain("Mission Eats has the best price ($1,680): it's the real quote cited to the others, so it isn't countered");
    expect(board.negotiation.map((s) => [s.business, s.channel]).sort()).toEqual([["Golden Grill", "imessage"], ["Harbor Table", "email"], ["Sunset Kitchen", "email"]]);
    expect(board.next).toMatch(/waiting for .*Golden Grill/);
    expect(board.businesses.find((b) => b.name === "Golden Grill")!.status).toBe("negotiating");

    // The answers (email, email, text) are new round-2 quotes; once all are in, quotes are final and the human is texted.
    await emailReply(engine, repo, deal.job_id, "Harbor Table", "We can do $2,670 total all-in, $934.50 deposit.");
    await text(engine, deal.job_id, GRILL, "ok $1,700 total all-in, $500 deposit");
    expect((await engine.getQuotes(deal.job_id)).ready).toBe(false); // still waiting for Sunset Kitchen
    await emailReply(engine, repo, deal.job_id, "Sunset Kitchen", "Best we can do is $2,627 total all-in, $525 deposit.");
    board = await engine.getQuotes(deal.job_id);
    expect(board.ready).toBe(true);
    expect(board.quotes.find((q) => q.business === "Golden Grill")).toMatchObject({ total_usd: 1700, round: 2 });
    expect(board.negotiation.find((s) => s.business === "Golden Grill")).toMatchObject({ outcome_total_usd: 1700, from_total_usd: 3350 });
    expect(texts.some((x) => x.to === HUMAN && /All quotes are in/.test(x.text))).toBe(true);
  });

  it("a phone business priced above the basis gets a counteroffer call; a 503 is retried and shown on the board; its answer is the new round", async () => {
    const { engine, repo, clock, calls } = demoEngine({ failCounterCalls: 1 });
    const deal = await engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await engine.advanceJob(deal.job_id);
    clock.advance(61_000); // the 60 s gap after the quote call: the first try hits capacity
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    expect((await summaries(repo, deal.job_id)).some((s) => /Counteroffer call to Mission Eats couldn't be placed \(503 hosted_agent_at_capacity\); retrying/.test(s))).toBe(true);
    expect((await engine.getQuotes(deal.job_id)).state).toBe("negotiating"); // still waits for the call
    clock.advance(61_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.idempotencyKey).toMatch(/^counter:/);
    expect(calls[1]!.reason).toMatch(/AI assistant/);
    expect(calls[1]!.reason).toMatch(/\$1,000(\.00)? total/);
    expect(calls[1]!.reason).not.toMatch(/Harbor/);
    await engine.ingestCall({ callId: "call_2", outcome: "completed", transcript: "agent: We have another quote of $1,000 total. Can you match it?\nremote: We can do $980 total all-in, 12 vegetarian, delivered, $100 deposit." });
    await engine.advanceJob(deal.job_id);
    const board = await engine.getQuotes(deal.job_id);
    expect(board.quotes.find((q) => q.business === "Mission Eats")).toMatchObject({ total_usd: 980, round: 2 });
    expect(board.ready).toBe(true);
  });

  it("email businesses countered and answered + a phone counter call that can never be placed: the round closes well within the window and the human gets the ready text", async () => {
    const { engine, repo, clock, calls, texts } = demoEngine({ failCounterCalls: 99 });
    const deal = await engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await emailReply(engine, repo, deal.job_id, "Sunset Kitchen", "$1,200 total all-in, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await engine.advanceJob(deal.job_id);
    expect((await engine.getQuotes(deal.job_id)).state).toBe("negotiating");
    await emailReply(engine, repo, deal.job_id, "Sunset Kitchen", "We can do $1,100 total all-in, $100 deposit.");
    for (let i = 0; i < 4; i++) {
      clock.advance(61_000);
      await engine.advanceJob(deal.job_id);
    }
    const board = await engine.getQuotes(deal.job_id);
    expect(calls).toHaveLength(1); // never placed
    expect(await summaries(repo, deal.job_id)).toContain("Counteroffer call to Mission Eats not placed after 3 tries (503 hosted_agent_at_capacity)");
    expect(board.ready).toBe(true); // ~4 min in, not the 10-minute window
    expect(texts.some((x) => x.to === HUMAN && /All quotes are in/.test(x.text))).toBe(true);
  });

  it("a counteroffer call scheduled past the window doesn't hold the round, and is reported as not placed once the round closes", async () => {
    const { engine, repo, clock, calls, texts } = demoEngine({ config: { negotiationWindowMs: 30_000 } });
    const deal = await engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await emailReply(engine, repo, deal.job_id, "Sunset Kitchen", "$1,200 total all-in, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Sunset Kitchen", "We can do $1,100 total all-in, $100 deposit.");
    expect((await engine.getQuotes(deal.job_id)).ready).toBe(true); // the call (60 s gap) can't happen inside the 30 s window
    clock.advance(61_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(1);
    expect(await summaries(repo, deal.job_id)).toContain("Counteroffer call to Mission Eats not placed: the negotiation round had closed");
    expect(texts.some((x) => x.to === HUMAN && /All quotes are in/.test(x.text))).toBe(true);
  });

  it("a counteroffer call still on the line when the window ends gets a short grace, then quotes are final", async () => {
    const { engine, repo, clock, calls } = demoEngine();
    const deal = await engine.deal({ request, budget_usd: 5000, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }, { name: "Mission Eats", phone: MISSION }] });
    await engine.advanceJob(deal.job_id);
    await emailReply(engine, repo, deal.job_id, "Harbor Table", "$1,000 total all-in, 12 vegetarian, delivered, $100 deposit.");
    await engine.ingestCall({ callId: "call_1", outcome: "completed", transcript: "agent: Hi.\nremote: $1,150 total all-in, 12 vegetarian, delivered, $150 deposit." });
    await engine.advanceJob(deal.job_id);
    clock.advance(61_000);
    await engine.advanceJob(deal.job_id);
    expect(calls).toHaveLength(2);
    clock.advance(9 * 60_000 + 30_000); // just past the 10-minute window, call not ended
    await engine.advanceJob(deal.job_id);
    expect((await engine.getQuotes(deal.job_id)).ready).toBe(false);
    clock.advance(4 * 60_000);
    await engine.advanceJob(deal.job_id);
    expect((await engine.getQuotes(deal.job_id)).ready).toBe(true);
  });
});
