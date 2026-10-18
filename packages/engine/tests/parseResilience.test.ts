// Parse resilience without replay. A busy or unreachable provider (429, 5xx, 529 overloaded, network)
// leaves the reply pending and it is read again on later ticks, a bounded number of times with growing
// delays (attempts are job events). A permanent error (400 invalid_request) is final at once. A message
// already "failed" is never read again (production job_868e… must never be reprocessed). The board says
// "Reply received; Haggle couldn't read a price", never the provider's error text. No network.
import { describe, expect, it } from "vitest";
import { disabledPayer, HaggleEngine, InMemoryRepository, StubBrain } from "../src/index.ts";
import { isTransientParseError, MAX_PARSE_RETRIES } from "../src/parsing/parseErrors.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";

const quote: QuoteExtraction = {
  available: true, price_per_head_usd: null, headcount: null, subtotal_usd: null, delivery_fee_usd: null, delivery_included: null, tax_usd: null, tax_included: null,
  total_usd: 1500, deposit_usd: 250, menu_items: [], dietary_coverage: [], valid_until: null, questions: [], payment_request: "none", instructions_to_agent: false,
  sources: [{ field: "total", source: "email body", excerpt: "$1500" }, { field: "deposit", source: "email body", excerpt: "$250 deposit" }], missing_fields: [], confidence: 0.9,
};
const apiError = (status: number, message: string) => Object.assign(new Error(`${status} ${message}`), { status });

function setup(fail: (call: number) => Error | null) {
  let t = Date.parse("2030-01-01T10:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  let calls = 0;
  const repo = new InMemoryRepository();
  const e = new HaggleEngine({
    repo, now: clock.now, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    extractor: { async extract() { calls++; const err = fail(calls); if (err) throw err; return structuredClone(quote); } } as never,
    email: { async send() { throw new Error("no email"); } },
    imessage: { async send() { return { messageId: `im_${Math.random()}` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 60 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 2 },
  });
  return { engine: e, repo, clock, calls: () => calls };
}
const BIZ = { name: "Sunset Kitchen", phone: "+14155550111", channel: "imessage" as const };
async function start(s: ReturnType<typeof setup>) {
  const deal = await s.engine.deal({ request: { what: "catering", quantity: 50, unit: "people", date: "2030-10-24", area: "San Francisco, CA", requirements: [] }, businesses: [BIZ] });
  await s.engine.ingestIMessage({ messageId: "in_1", from: BIZ.phone, text: "$1500, $250 deposit", isGroup: false });
  await s.engine.advanceJob(deal.job_id);
  return deal.job_id;
}
const inbound = async (s: ReturnType<typeof setup>, jobId: string) => (await s.repo.listMessages(jobId)).find((m) => m.direction === "in")!;

describe("which failures are transient", () => {
  it("429, 5xx, 529 and network errors retry; 400/401 and refusals don't", () => {
    for (const s of [429, 500, 503, 529, 408]) expect(isTransientParseError(apiError(s, "x"))).toBe(true);
    expect(isTransientParseError(Object.assign(new Error("Connection error."), { name: "APIConnectionError" }))).toBe(true);
    expect(isTransientParseError(new Error("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }))).toBe(true);
    for (const s of [400, 401, 403, 404]) expect(isTransientParseError(apiError(s, "invalid_request_error"))).toBe(false);
    expect(isTransientParseError(new Error("model refused to extract"))).toBe(false);
  });
});

describe("parse resilience", () => {
  it("an overloaded provider: the reply stays pending, is read again after a back-off, and becomes a quote", async () => {
    const s = setup((n) => (n <= 2 ? apiError(529, "overloaded_error") : null));
    const jobId = await start(s);
    expect(s.calls()).toBe(1);
    expect((await inbound(s, jobId)).parse_status).toBe("pending");
    await s.engine.advanceJob(jobId); // still backing off: no call
    expect(s.calls()).toBe(1);
    s.clock.advance(31_000);
    await s.engine.advanceJob(jobId); // attempt 2 fails, longer back-off
    expect(s.calls()).toBe(2);
    s.clock.advance(61_000);
    await s.engine.advanceJob(jobId);
    expect(s.calls()).toBe(3);
    expect((await inbound(s, jobId)).parse_status).toBe("done");
    const board = await s.engine.getQuotes(jobId);
    expect(board.quotes[0]).toMatchObject({ total_usd: 1500, deposit_usd: 250 });
    expect((await s.repo.listEvents(jobId)).filter((e) => e.type === "parse_retry").map((e) => e.data.attempt)).toEqual([1, 2]);
  });

  it("transient forever: bounded attempts, then failed and shown as unreadable", async () => {
    const s = setup(() => apiError(503, "service unavailable"));
    const jobId = await start(s);
    for (let i = 0; i < 10; i++) { s.clock.advance(10 * 60_000); await s.engine.advanceJob(jobId); }
    expect(s.calls()).toBe(MAX_PARSE_RETRIES + 1);
    expect((await inbound(s, jobId)).parse_status).toBe("failed");
  });

  it("a permanent error (400 invalid_request): failed at once, never read again; the board says so plainly", async () => {
    const s = setup(() => apiError(400, "invalid_request_error: compiled grammar is too large"));
    const jobId = await start(s);
    expect((await inbound(s, jobId)).parse_status).toBe("failed");
    for (let i = 0; i < 5; i++) { s.clock.advance(10 * 60_000); await s.engine.advanceJob(jobId); }
    expect(s.calls()).toBe(1); // a failed message is never replayed
    const board = await s.engine.getQuotes(jobId);
    const b = board.businesses[0]!;
    expect(board.stages![b.business_id]!.stage).toBe("reply_unreadable");
    expect(b.last_event).toBe("Reply received; Haggle couldn't read a price");
    expect(JSON.stringify(board)).not.toMatch(/grammar|invalid_request/);
    expect((await s.repo.listEvents(jobId)).find((e) => e.type === "parse_failed")!.data).toMatchObject({ error: "http_400" });
  });

  it("a later readable reply from the same business replaces 'unreadable'", async () => {
    const s = setup((n) => (n === 1 ? apiError(400, "bad") : null));
    const jobId = await start(s);
    await s.engine.ingestIMessage({ messageId: "in_2", from: BIZ.phone, text: "$1500, $250 deposit again", isGroup: false });
    await s.engine.advanceJob(jobId);
    const board = await s.engine.getQuotes(jobId);
    const b = board.businesses[0]!;
    expect(board.stages![b.business_id]!.stage).not.toBe("reply_unreadable");
    expect(board.quotes[0]).toMatchObject({ total_usd: 1500 });
  });
});
