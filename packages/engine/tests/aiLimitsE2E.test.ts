// AI-cost limits end to end, wired as apps/mcp/src/live.ts wires them (sprint 4, workstream F): the
// meter's onLimit goes to the alerter, Claude reads through the metered client and extractor, and
// the engine logs through alertingLog. Over a job's call limit its reply is held: no Claude call,
// no quote, an operator review (kind parse) the ops report lists, one alert; other jobs carry on.
// The daily token budget holds every job's replies and alerts once; calls made outside any job (a
// tool's strategist call) still count toward the day. Fake Anthropic client and webhook.
import { describe, expect, it } from "vitest";
import { AiUsageMeter, alertingLog, buildOpsReport, createAlerter, meteredExtractor, type ExtractorPort } from "../src/index.ts";
import { BUDGET, kit, mail, REQUEST, textExtractor } from "./helpers/reliabilityKit.ts";

function liveLike(limits: { maxCallsPerJob?: number; dailyTokenBudget?: number }) {
  const posts: string[] = [];
  let now = Date.parse("2026-10-22T15:00:00Z");
  const alerts = createAlerter({ url: "https://hooks.slack.test/x", now: () => now, fetch: (async (_u: string, init: RequestInit) => { posts.push(JSON.parse(String(init.body)).text); return new Response("ok"); }) as typeof fetch });
  // The same onLimit as live.ts.
  const meter = new AiUsageMeter({
    limits,
    onLimit: ({ limit, scope }) => void alerts.alert({ key: `ai_limit:${limit}:${limit === "daily_tokens" ? "day" : scope.jobId ?? "?"}`, severity: "warn", summary: limit === "daily_tokens" ? "AI daily token budget reached: new replies are held for human review until the UTC day rolls over" : `AI call limit reached for job ${scope.jobId}: its new replies are held for human review`, details: { limit, job_id: scope.jobId ?? null } }),
  });
  // Claude as the meter sees it: each read is admitted (refused over a limit before "reaching
  // Anthropic"), its usage recorded, then the reply read.
  const seen: unknown[] = [];
  const claude: ExtractorPort = { async extract(i) { meter.admit(); seen.push(i.message.id); meter.record(meter.current(), { input_tokens: 1000, output_tokens: 200 }); return textExtractor.extract(i); } };
  const extractor = meteredExtractor(claude, meter);
  const k = kit({}, { extractor });
  (k.engine as unknown as { d: { log: unknown } }).d.log = alertingLog((e, d) => k.logs.push({ event: e, data: d }), alerts);
  return { k, meter, posts, seen, advanceTime: (ms: number) => { now += ms; } };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("AI-cost limits, live wiring", () => {
  it("a job over its call limit: the reply is held (no Claude call, no quote), reviewed, reported and alerted once; another job is unaffected", async () => {
    const t = liveLike({ maxCallsPerJob: 1 });
    const a = await t.k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    const b = await t.k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }] });
    const [ha] = await t.k.repo.getBusinesses(a.job_id);
    const [sb] = await t.k.repo.getBusinesses(b.job_id);
    await mail(t.k, ha!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await t.k.engine.advanceJob(a.job_id); // 1 read: the job's budget
    const callsAfterFirst = t.seen.length;
    await mail(t.k, ha!, "Revised: $1,100 total, delivered.");
    await t.k.engine.advanceJob(a.job_id); // refused before reaching Claude
    expect(t.seen.length).toBe(callsAfterFirst);
    expect((await t.k.engine.getQuotes(a.job_id)).quotes.map((q) => q.total_usd)).toEqual([1150]);
    const review = (await t.k.repo.listReviews({ status: "open", jobId: a.job_id })).find((r) => r.kind === "parse");
    expect(review?.reason).toMatch(/couldn't be read/);
    const report = await buildOpsReport(t.k.repo, { now: t.k.clock.now() });
    expect(report.workspaces[0]!.reviews.some((r) => r.id === review!.id)).toBe(true);
    // The other job still gets its replies read.
    await mail(t.k, sb!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await t.k.engine.advanceJob(b.job_id);
    expect((await t.k.engine.getQuotes(b.job_id)).quotes).toHaveLength(1);
    // A third reply on job A: refused again, but the alert fired once.
    await mail(t.k, ha!, "Final: $1,050 total.");
    await t.k.engine.advanceJob(a.job_id);
    await settle();
    expect(t.posts.filter((p) => p.includes(`AI call limit reached for job ${a.job_id}`))).toHaveLength(1);
    expect(t.posts.some((p) => /Operator review opened \(parse\)/.test(p))).toBe(true);
    expect(t.meter.snapshot()).toMatchObject({ jobs_at_call_limit: 2, refused: 2 }); // both jobs used their one read; only A was refused (twice)
  });

  it("the daily token budget holds every job's replies until the UTC day rolls over; calls outside a job count toward it; one alert per day", async () => {
    const t = liveLike({ dailyTokenBudget: 3000 });
    // A tool path (e.g. the negotiate tool's strategist) spends tokens outside any job scope.
    t.meter.admit({});
    t.meter.record({}, { input_tokens: 2500, output_tokens: 0 });
    const a = await t.k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Harbor Table", email: "harbor@inkboxmail.test" }] });
    const [ha] = await t.k.repo.getBusinesses(a.job_id);
    await mail(t.k, ha!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await t.k.engine.advanceJob(a.job_id); // the read fits (2,500 < 3,000) and spends 1,200 more: the budget is now spent
    expect(t.meter.snapshot()).toMatchObject({ daily_budget_reached: true });
    const b = await t.k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }] });
    const [sb] = await t.k.repo.getBusinesses(b.job_id);
    const before = t.seen.length;
    await mail(t.k, sb!, "We can do it: $1,200 total, delivered.");
    await t.k.engine.advanceJob(b.job_id);
    expect(t.seen.length).toBe(before); // no Claude call at all
    expect((await t.k.engine.getQuotes(b.job_id)).quotes).toHaveLength(0);
    await settle();
    expect(t.posts.filter((p) => /daily token budget reached/.test(p))).toHaveLength(1);
    expect((await t.k.repo.listReviews({ status: "open", jobId: b.job_id })).some((r) => r.kind === "parse")).toBe(true);
  });
});
