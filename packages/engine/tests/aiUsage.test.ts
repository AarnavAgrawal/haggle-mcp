// AI usage controls (live/aiUsage.ts): Claude calls are metered from response usage and limited per
// job and per UTC day; over a limit the call never reaches Anthropic and the reply is held for a
// human (a failed read), never a keyword or approvable quote. Fake clients only.
import { describe, expect, it } from "vitest";
import { AiBudgetExceeded, AiUsageMeter, aiLimitsFromEnv, claudeExtractor, claudeStrategist, disabledPayer, GOLDEN_REQUEST, HaggleEngine, InMemoryRepository, meteredClient, meteredExtractor, StubBrain, UNREADABLE_REPLY, withHeuristicFallback, type ParserClient } from "../src/index.ts";

const { budget_usd, ...request } = GOLDEN_REQUEST;
const trusted = (expected: string) => ({ trusted: true as const, address: expected, reason: "trusted" as const, evidence: { dmarc: null, dmarcPolicy: null, dmarcFromDomain: null, spf: null, alignedDkimDomains: [] } });

/** A fake Anthropic client answering parseReply's two structured calls; counts calls. */
function fakeClaude(usage = { input_tokens: 1000, output_tokens: 200 }) {
  const seen: unknown[] = [];
  const client = {
    messages: {
      parse: async (body: { output_config?: unknown }) => {
        seen.push(body);
        return { stop_reason: "end_turn", usage, parsed_output: { available: true, total_usd: 1150, deposit_usd: 345, items: ["lunch"], meets_requirements: true, confidence: 0.9, sources: [{ field: "total", source: "email body", excerpt: "$1,150 total" }] } };
      },
    },
  };
  return { client: client as unknown as ParserClient, seen };
}

describe("the meter", () => {
  it("reads limits from the environment (unset or invalid = off)", () => {
    expect(aiLimitsFromEnv({ HAGGLE_AI_MAX_CALLS_PER_JOB: "40", HAGGLE_AI_DAILY_TOKEN_BUDGET: "2000000" })).toEqual({ maxCallsPerJob: 40, dailyTokenBudget: 2_000_000 });
    expect(aiLimitsFromEnv({ HAGGLE_AI_MAX_CALLS_PER_JOB: "-1", HAGGLE_AI_DAILY_TOKEN_BUDGET: "lots" })).toEqual({ maxCallsPerJob: undefined, dailyTokenBudget: undefined });
  });

  it("counts calls and tokens per job, per workspace and per day from response usage", async () => {
    const meter = new AiUsageMeter({ workspaceOf: async (j) => (j === "job_a" ? "ws_acme" : null) });
    const { client, seen } = fakeClaude({ input_tokens: 100, output_tokens: 20 });
    const metered = meteredClient(client, meter);
    await meter.run({ jobId: "job_a" }, () => (metered.messages.parse as (b: object) => Promise<unknown>)({}));
    await meter.run({ jobId: "job_a" }, () => (metered.messages.parse as (b: object) => Promise<unknown>)({}));
    await (metered.messages.parse as (b: object) => Promise<unknown>)({}); // unscoped: counts toward the day only
    await new Promise((r) => setTimeout(r, 0)); // workspace attribution resolves asynchronously
    expect(seen).toHaveLength(3);
    const u = meter.usage();
    expect(u.total).toMatchObject({ calls: 3, tokensIn: 300, tokensOut: 60 });
    expect(u.jobs.job_a).toMatchObject({ calls: 2, tokensIn: 200, tokensOut: 40 });
    expect(u.workspaces.ws_acme).toMatchObject({ calls: 2, tokensIn: 200 });
    expect(meter.snapshot()).toMatchObject({ calls: 3, tokens_in: 300, tokens_out: 60, daily_tokens_remaining: null, daily_budget_reached: false });
  });

  it("refuses a job's call over HAGGLE_AI_MAX_CALLS_PER_JOB before it reaches Anthropic; other jobs continue", async () => {
    const limits: string[] = [];
    const meter = new AiUsageMeter({ limits: { maxCallsPerJob: 2 }, onLimit: ({ limit }) => limits.push(limit) });
    const { client, seen } = fakeClaude();
    const parse = meteredClient(client, meter).messages.parse as (b: object) => Promise<unknown>;
    await meter.run({ jobId: "job_a" }, async () => { await parse({}); await parse({}); });
    await expect(meter.run({ jobId: "job_a" }, () => parse({}))).rejects.toBeInstanceOf(AiBudgetExceeded);
    await expect(meter.run({ jobId: "job_a" }, () => parse({}))).rejects.toMatchObject({ limit: "calls_per_job" });
    await meter.run({ jobId: "job_b" }, () => parse({}));
    expect(seen).toHaveLength(3);
    expect(limits).toEqual(["calls_per_job"]); // alerted once
    expect(meter.snapshot()).toMatchObject({ refused: 2, jobs_at_call_limit: 1 });
  });

  it("refuses every call once the daily token budget is spent, until the UTC day rolls over", async () => {
    let now = new Date("2026-10-22T23:59:00Z");
    const meter = new AiUsageMeter({ limits: { dailyTokenBudget: 2_000 }, now: () => now });
    const { client, seen } = fakeClaude({ input_tokens: 1500, output_tokens: 600 });
    const parse = meteredClient(client, meter).messages.parse as (b: object) => Promise<unknown>;
    await parse({}); // 2,100 tokens: the budget is spent after this one
    await expect(parse({})).rejects.toMatchObject({ limit: "daily_tokens" });
    expect(meter.snapshot()).toMatchObject({ daily_budget_reached: true, daily_tokens_remaining: 0 });
    now = new Date("2026-10-23T00:00:01Z");
    await parse({});
    expect(seen).toHaveLength(2);
    expect(meter.snapshot()).toMatchObject({ day: "2026-10-23", calls: 1, daily_budget_reached: true });
  });

  it("the strategist over budget falls back (it throws; the engine then uses the truthful rules)", async () => {
    const meter = new AiUsageMeter({ limits: { dailyTokenBudget: 1 } });
    meter.record({}, { input_tokens: 5, output_tokens: 0 });
    const { client, seen } = fakeClaude();
    const s = claudeStrategist(meteredClient(client, meter, "strategist") as never, "m");
    await expect(s.decide([], { what: "lunch", targetUsd: 1000, hardLimit: false, quotes: [] })).rejects.toBeInstanceOf(AiBudgetExceeded);
    expect(seen).toHaveLength(0);
  });
});

async function replyOnJob(extractor: ReturnType<typeof meteredExtractor>) {
  const repo = new InMemoryRepository();
  const engine = new HaggleEngine({
    repo, extractor, attachments: { load: async () => [] }, brain: new StubBrain(), payer: disabledPayer("off"),
    email: { async send() { return { providerId: `em_${Math.random()}`, status: "sent", idempotentReplay: false, messageId: `<em_${Math.random()}@haggle.test>` }; } },
    config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1 },
  });
  const deal = await engine.deal({ request, budget_usd, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
  const rfq = (await repo.getBusinesses(deal.job_id))[0]!.rfq_message_id!;
  await engine.ingest({ providerEventId: "e1", eventType: "message.received", providerEmailId: "in_1", threadId: "t1", messageId: "<in_1@x>", inReplyTo: [rfq], references: [rfq], from: "harbor@inkboxmail.test", to: ["haggle@inkboxmail.test"], subject: "Re: quote", bodyText: "We can do it: $1,150 total, delivered. $345 deposit.", attachments: [], attachmentsDownloadUrl: null }, trusted);
  await engine.advanceJob(deal.job_id);
  return { engine, repo, jobId: deal.job_id };
}

describe("over a limit, a reply is held for a human (engine path)", () => {
  it("within limits Claude reads the reply and the call is attributed to the job", async () => {
    const meter = new AiUsageMeter({ limits: { maxCallsPerJob: 10 } });
    const { client, seen } = fakeClaude();
    const extractor = meteredExtractor(withHeuristicFallback(claudeExtractor({ apiKey: "x", model: "m", meter, client })), meter);
    const { repo, jobId } = await replyOnJob(extractor);
    expect(seen).toHaveLength(2); // the core and details calls
    expect(meter.usage().jobs[jobId]).toMatchObject({ calls: 2, tokensIn: 2000, tokensOut: 400 });
    expect((await repo.listEvents(jobId)).some((e) => e.type === "parse_failed" && (e.data as { error?: string }).error === "AiBudgetExceeded")).toBe(false);
  });

  it("the job's call limit: no Claude call, no keyword quote, no approvable quote; the reply shows as unread", async () => {
    const limited = new AiUsageMeter({ limits: { maxCallsPerJob: 1 } });
    const { client, seen } = fakeClaude();
    const extractor = meteredExtractor(withHeuristicFallback(claudeExtractor({ apiKey: "x", model: "m", meter: limited, client })), limited);
    const { engine, repo, jobId } = await replyOnJob(extractor);
    // The core call was admitted; the details call (the job's second) was refused, so the read failed.
    expect(seen).toHaveLength(1);
    expect((await engine.getQuotes(jobId)).quotes).toHaveLength(0);
    const events = await repo.listEvents(jobId);
    expect(events.some((e) => e.type === "parse_failed" && (e.data as { error?: string }).error === "AiBudgetExceeded")).toBe(true);
    expect(events.some((e) => e.type === "reply" && (e.data as { summary?: string }).summary === UNREADABLE_REPLY)).toBe(true);
    expect(events.some((e) => e.type === "parse_retry")).toBe(false); // final: not retried in a loop
  });

  it("the daily budget: the reply is held without calling Claude at all", async () => {
    const meter = new AiUsageMeter({ limits: { dailyTokenBudget: 10 } });
    meter.record({}, { input_tokens: 10, output_tokens: 0 });
    const { client, seen } = fakeClaude();
    const extractor = meteredExtractor(withHeuristicFallback(claudeExtractor({ apiKey: "x", model: "m", meter, client })), meter);
    const { engine, repo, jobId } = await replyOnJob(extractor);
    expect(seen).toHaveLength(0);
    expect((await engine.getQuotes(jobId)).quotes).toHaveLength(0);
    expect((await repo.listEvents(jobId)).some((e) => e.type === "parse_failed")).toBe(true);
  });
});
