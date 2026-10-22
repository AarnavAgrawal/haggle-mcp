// Unreliable extraction never becomes an approvable price (production audit 2026-10-21). When Claude
// is busy the reply waits and is read again (bounded), never silently swapped for the keyword
// reader; when Claude can't read it at all, the keyword reading is shown but can't be approved; a
// half-failed read (the details call) is a failure, not a quote missing its fees; every call has a
// timeout. Fake clients, no network.
import { describe, expect, it } from "vitest";
import { createAnthropicClient, disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, parseReply, ParseError, StubBrain, withHeuristicFallback, type ParserClient } from "../src/index.ts";
import type { ExtractorPort } from "../src/workflow/ports.ts";

const { budget_usd, ...request } = GOLDEN_REQUEST;
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });
const overloaded = () => Object.assign(new Error("Overloaded"), { status: 529 });

async function quoteThrough(extractor: ExtractorPort) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, now: clock.now, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send() { return { providerId: `em_${Math.random()}`, status: "sent", idempotentReplay: false, messageId: `<em_${Math.random()}@haggle.test>` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
  });
  const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
  const rfq = (await repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!;
  await engine.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_1", threadId: "t1", messageId: "<in_1@x>", inReplyTo: [rfq], references: [rfq], from: "harbor@inkboxmail.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "We can do it: $1,150 total, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
  await engine.advanceJob(deal.job_id);
  return { engine, repo, clock, jobId: deal.job_id };
}

describe("extraction failures are explicit", () => {
  it("a busy Claude (529) is retried later, not replaced by the keyword reader", async () => {
    let calls = 0;
    const primary: ExtractorPort = { async extract() { calls++; throw overloaded(); } };
    const { engine, repo, jobId } = await quoteThrough(withHeuristicFallback(primary));
    expect(calls).toBe(1);
    expect((await engine.getQuotes(jobId)).quotes).toHaveLength(0); // no keyword quote stood in
    expect((await repo.listEvents(jobId)).some((e) => e.type === "parse_retry")).toBe(true);
  });

  it("when Claude can't read a reply, the keyword reading is shown but can't be approved", async () => {
    const primary: ExtractorPort = { async extract() { throw new ParseError("model refused to extract"); } };
    const { engine, jobId } = await quoteThrough(withHeuristicFallback(primary));
    const board = await engine.getQuotes(jobId);
    const q = board.quotes.find((x) => x.business === "Harbor Table")!;
    expect(q.total_usd).toBe(1150);
    expect(q.approvable).toBe(false);
    expect(q.approval_block).toMatchObject({ code: "unreliable_extraction" });
    await expect(engine.requestApproval(jobId, q.quote_id, "imessage")).rejects.toMatchObject({ code: "quote_not_eligible" });
  });

  it("a failed details call fails the read instead of storing a quote without its fees and tax", async () => {
    let n = 0;
    const client = { messages: { parse: async () => { n++; if (n === 2) throw overloaded(); return { stop_reason: "end_turn", parsed_output: { available: true, total_usd: 1000 } }; } } } as unknown as ParserClient;
    await expect(parseReply(client, "m", { request: { what: "lunch", quantity: 40, date: "2026-11-01", dietary: [], requirements: [] } as never, bodyText: "$1,000 plus a $200 service fee" })).rejects.toMatchObject({ status: 529 });
  });

  it("every Claude call has a timeout", () => {
    const c = createAnthropicClient({ apiKey: "sk-ant-test" }) as unknown as { timeout: number; maxRetries: number };
    expect(c.timeout).toBeLessThanOrEqual(60_000);
    expect(c.maxRetries).toBeLessThanOrEqual(2);
  });
});
