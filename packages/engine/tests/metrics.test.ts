// Sprint 5 (E): usage metrics from database rows only, with one simulated-vs-real rule. Hand-built
// datasets pin every measure; a mock-mode engine run proves its jobs land in the simulated bucket;
// the AI meter persists per-call usage (migration 122) and metrics price it; on Postgres (when
// HAGGLE_TEST_DATABASE_URL is set) the SQL loader reads mixed real/simulated/test rows in a rolled-back
// transaction and never includes a simulated row in the real numbers.
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import {
  AiUsageMeter, aiUsageSink, buildMetricsReport, callCostUsd, classifyJob, computeBucket, createMockEngine, fleetBusinesses, InMemoryRepository, loadMetricsDataset, loadMetricsDatasetFromRepo,
  markTest, meteredClient, metricsText, MODEL_PRICES_USD_PER_MTOK, PostgresRepository, pricesWithOverride, simulatedStripe, splitDataset, summarizeCost, testTargets, type MetricsDataset, type ParserClient,
} from "../src/index.ts";

const T = (min: number) => new Date(Date.parse("2026-10-01T16:00:00Z") + min * 60_000).toISOString();
const empty = (): MetricsDataset => ({ jobs: [], businesses: [], messages: [], quotes: [], questions: [], approvals: [], bookings: [], handoffs: [], receipts: [], payments: [], events: [], reviews: [], quarantine: [], held_texts: [], test_marks: [], ai_usage: [] });
const usage = (job: string | null, model: string, input: number, output: number) => ({ id: 0, job_id: job, workspace_id: null, purpose: "extract", model, input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, at: T(1) });

/**
 * One real job (two real vendors + one simulated vendor), one mock job, one live job in a test
 * workspace, one live job marked test, one live job reaching only the simulated fleet.
 */
function mixed(): MetricsDataset {
  const d = empty();
  const job = (id: string, workspace_id: string, mode: "live" | "mock", state = "paid") => d.jobs.push({ id, workspace_id, mode, state, created_at: T(0), updated_at: T(300) });
  const biz = (job_id: string, business_id: string, channel: string, simulated: boolean, contacted = true) => d.businesses.push({ job_id, business_id, channel, simulated, status: "quoted", contacted_at: contacted ? T(1) : null, escalated_at: null });
  const reply = (job_id: string, business_id: string, simulated = false, trusted = true) => d.messages.push({ job_id, business_id, direction: "in", kind: "reply", channel: "email", sender_trusted: trusted, simulated, created_at: T(10) });
  const quote = (job_id: string, business_id: string, total: number | null, min: number, compliant = true) => d.quotes.push({ job_id, business_id, status: "current", total_cents: total, compliant, sender_trusted: true, created_at: T(min) });
  job("job_real", "ws_pilot", "live");
  biz("job_real", "biz_harbor", "email", false); biz("job_real", "biz_sunset", "imessage", false); biz("job_real", "biz_sim", "email", true); biz("job_real", "biz_grill", "phone", false);
  reply("job_real", "biz_harbor"); reply("job_real", "biz_sunset"); reply("job_real", "biz_sim", true); reply("job_real", "biz_grill", false, false);
  quote("job_real", "biz_harbor", 218_000, 30); quote("job_real", "biz_sunset", 230_000, 45, false); quote("job_real", "biz_sim", 99_000, 5);
  d.questions.push({ id: "qs_human", job_id: "job_real", business_id: "biz_sunset", status: "answered", answered_at: T(20) }, { id: "qs_auto", job_id: "job_real", business_id: "biz_harbor", status: "answered", answered_at: T(12) });
  d.approvals.push({ id: "ap_real", job_id: "job_real", business_id: "biz_harbor", channel: "imessage", status: "used", decided_at: T(60), created_at: T(50) });
  d.bookings.push({ job_id: "job_real", business_id: "biz_harbor", approval_id: "ap_real", status: "confirmed", confirmed_at: T(120) });
  d.handoffs.push({ id: "ho_real", job_id: "job_real", business_id: "biz_harbor", status: "human_confirmed", confirmed_at: T(200) });
  d.receipts.push({ handoff_id: "ho_real", job_id: "job_real", created_at: T(250) });
  const ev = (job_id: string, seq: number, type: string, data: Record<string, unknown>, min: number) => d.events.push({ job_id, seq, type, data, at: T(min) });
  ev("job_real", 1, "state", { from: null, to: "created" }, 0);
  ev("job_real", 2, "state", { from: "contacting", to: "collecting" }, 1);
  ev("job_real", 3, "quote", { business_id: "biz_sim", total_usd: 990 }, 5);
  ev("job_real", 4, "reply", { kind: "question_auto_answered", question_id: "qs_auto" }, 12);
  ev("job_real", 5, "quote", { business_id: "biz_harbor", total_usd: 2180 }, 30);
  ev("job_real", 6, "approval_requested", { approval_id: "ap_real" }, 50);
  ev("job_real", 7, "booking", { status: "confirmed", approval_id: "ap_real", by: "human_ack" }, 120);
  ev("job_real", 8, "payment", { status: "human_reported_paid" }, 200);
  ev("job_real", 9, "payment", { status: "settled_verified" }, 250);
  ev("job_real", 10, "state", { from: "paying", to: "paid" }, 250);
  ev("job_real", 11, "text_released", {}, 100);
  d.reviews.push({ job_id: "job_real", kind: "outbox", status: "resolved" });
  d.quarantine.push({ job_id: "job_real", decision: "released" });
  d.ai_usage.push(usage("job_real", "claude-sonnet-5-5", 10_000, 1_000));

  job("job_mock", "ws_pilot", "mock");
  biz("job_mock", "biz_harbor", "email", false); reply("job_mock", "biz_harbor"); quote("job_mock", "biz_harbor", 100_000, 3);
  ev("job_mock", 1, "quote", { business_id: "biz_harbor", total_usd: 1000 }, 3);
  job("job_testws", "ws_demo", "live"); biz("job_testws", "biz_harbor", "email", false); quote("job_testws", "biz_harbor", 100_000, 3);
  job("job_marked", "ws_pilot", "live"); biz("job_marked", "biz_harbor", "email", false);
  job("job_fleet", "ws_pilot", "live"); biz("job_fleet", "biz_sim", "email", true); quote("job_fleet", "biz_sim", 50_000, 2);
  d.test_marks.push({ target_kind: "workspace", target_id: "ws_demo", marked: true }, { target_kind: "job", target_id: "job_marked", marked: true }, { target_kind: "job", target_id: "job_real", marked: true }, { target_kind: "job", target_id: "job_real", marked: false });
  d.ai_usage.push(usage("job_mock", "claude-sonnet-5-5", 50_000, 5_000), usage(null, "claude-sonnet-5-5", 1_000, 100));
  return d;
}

describe("the simulated-vs-real rule", () => {
  it("classifies each job by the first failing condition; the latest test mark wins", () => {
    const marks = testTargets(mixed().test_marks);
    expect([...marks.workspaces]).toEqual(["ws_demo"]);
    expect([...marks.jobs]).toEqual(["job_marked"]); // job_real was unmarked afterwards
    const real = { simulated: false }, sim = { simulated: true };
    expect(classifyJob({ id: "j", workspace_id: "ws_demo", mode: "mock" }, [real], marks)).toBe("mock_mode");
    expect(classifyJob({ id: "j", workspace_id: "ws_demo", mode: "live" }, [real], marks)).toBe("test_workspace");
    expect(classifyJob({ id: "job_marked", workspace_id: "ws_pilot", mode: "live" }, [real], marks)).toBe("test_job");
    expect(classifyJob({ id: "j", workspace_id: "ws_pilot", mode: "live" }, [sim, sim], marks)).toBe("simulated_vendors_only");
    expect(classifyJob({ id: "j", workspace_id: "ws_pilot", mode: "live" }, [], marks)).toBe("simulated_vendors_only");
    expect(classifyJob({ id: "j", workspace_id: "ws_pilot", mode: "live" }, [sim, real], marks)).toBeNull();
  });

  it("real numbers never include a simulated row: adding or removing simulated rows leaves them unchanged", () => {
    const d = mixed();
    const s = splitDataset(d);
    expect(s.real.jobs.map((j) => j.id)).toEqual(["job_real"]);
    expect(s.simulated.jobs.map((j) => j.id).sort()).toEqual(["job_fleet", "job_marked", "job_mock", "job_testws"]);
    expect(s.reasons).toEqual({ mock_mode: 1, test_workspace: 1, test_job: 1, simulated_vendors_only: 1 });
    expect(s.real.businesses.some((b) => b.simulated)).toBe(false);
    expect(s.real.messages.some((m) => m.simulated || m.business_id === "biz_sim")).toBe(false);
    expect(s.real.quotes.some((q) => q.business_id === "biz_sim")).toBe(false);
    expect(s.real.events.some((e) => e.data.business_id === "biz_sim")).toBe(false);
    expect(s.excluded).toEqual({ simulated_businesses: 1, simulated_messages: 1, quotes_from_simulated_businesses: 1 });
    // Property: strip every simulated row from the input; the real bucket is identical.
    const stripped = { ...d, businesses: d.businesses.filter((b) => !b.simulated), messages: d.messages.filter((m) => !m.simulated), quotes: d.quotes.filter((q) => q.business_id !== "biz_sim"), events: d.events.filter((e) => e.data.business_id !== "biz_sim") };
    const a = computeBucket(s.real), b = computeBucket(splitDataset(stripped).real);
    expect(b).toEqual(a);
    // ...and doubling the simulated jobs changes only the simulated bucket.
    const doubled = { ...d, jobs: [...d.jobs, { ...d.jobs.find((j) => j.id === "job_mock")!, id: "job_mock2" }], quotes: [...d.quotes, { ...d.quotes.find((q) => q.job_id === "job_mock")!, job_id: "job_mock2" }] };
    expect(computeBucket(splitDataset(doubled).real)).toEqual(a);
    expect(computeBucket(splitDataset(doubled).simulated).jobs).toBe(5);
  });
});

describe("measures (from rows only)", () => {
  it("sourcing, response by channel, interventions, timings, funnel and AI cost over the real job", () => {
    const r = buildMetricsReport(mixed(), { minValidQuotes: 2, now: new Date(T(400)) });
    const m = r.real;
    expect(m.jobs).toBe(1);
    // Harbor is valid; Sunset is priced but misses a must; the simulated vendor's quote is not counted.
    expect(m.sourcing).toMatchObject({ jobs_with_vendor_contacted: 1, jobs_with_priced_quote: 1, jobs_with_1_valid_quote: 1, jobs_with_n_valid_quotes: 0, rate_1_valid: 1, rate_n_valid: 0 });
    // Grill's reply was from an unverified sender: contacted, not replied.
    expect(m.response_by_channel).toEqual({
      email: { contacted: 1, replied: 1, quoted: 1, reply_rate: 1, quote_rate: 1 },
      imessage: { contacted: 1, replied: 1, quoted: 1, reply_rate: 1, quote_rate: 1 },
      phone: { contacted: 1, replied: 0, quoted: 0, reply_rate: 0, quote_rate: 0 },
    });
    expect(m.response_total).toMatchObject({ contacted: 3, replied: 2, quoted: 2, reply_rate: 0.667 });
    expect(m.interventions).toMatchObject({
      human_answers_to_business: 1, auto_answers_to_business: 1, booked_attestations: 1, operator_reviews_opened: 1, operator_reviews_resolved: 1,
      quarantine_released: 1, held_texts_released: 1, total: 5, per_job: 5,
    });
    // First REAL quote at 30 min (the simulated vendor's at 5 min doesn't count), approval 60, booking 120, done 250.
    expect(m.timings.time_to_first_quote).toMatchObject({ n: 1, median_s: 1800 });
    expect(m.timings.time_to_approval.median_s).toBe(3600);
    expect(m.timings.time_to_booking.median_s).toBe(7200);
    expect(m.timings.total_job_duration.median_s).toBe(15_000);
    expect(m.funnel.reached.completed).toBe(1);
    expect(m.funnel.drop_off.every((x) => x.lost === 0)).toBe(true);
    expect(m.ai).toMatchObject({ calls: 1, input_tokens: 10_000, output_tokens: 1_000, approx_usd: 0.03, jobs_with_usage: 1 }); // 10k x $2/M + 1k x $10/M
    // Simulated side: the mock job's usage, and the drop-off where test jobs stopped.
    expect(r.simulated.ai.approx_usd).toBeCloseTo(0.15, 6);
    expect(r.simulated.funnel.drop_off.find((x) => x.from === "created")!.lost).toBeGreaterThanOrEqual(0);
    expect(r.ai_unattributed.calls).toBe(1);
    const text = metricsText(r);
    expect(text).toMatch(/REAL\s+SIMULATED/);
    expect(text).toContain("Simulated because: mock_mode 1, test_workspace 1, test_job 1, simulated_vendors_only 1.");
    expect(text).toMatch(/APPROXIMATE/);
  });

  it("timing distributions: median, p90 and n; nothing recorded is '-', never 0", () => {
    const d = empty();
    expect(computeBucket(d).timings.time_to_first_quote).toEqual({ n: 0, median_s: null, p90_s: null, mean_s: null });
    expect(computeBucket(d).sourcing.rate_1_valid).toBeNull();
  });
});

describe("approximate AI cost (documented price table)", () => {
  it("prices calls by model, cache reads and writes, Haiku's long-prompt tier, and flags unknown models", () => {
    expect(callCostUsd({ model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }).usd).toBe(12);
    expect(callCostUsd({ model: "claude-sonnet-5-5", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }).usd).toBeCloseTo(2.5 + 0.2, 9);
    expect(callCostUsd({ model: "claude-haiku-5-5", input_tokens: 200_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }).usd).toBeCloseTo(0.1, 9); // over 100K: $0.50/M
    const unknown = callCostUsd({ model: "claude-unknown-9", input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
    expect(unknown).toEqual({ usd: 10, priced: false });
    expect(summarizeCost([usage("j", "claude-unknown-9", 1, 1)]).unpriced_models).toEqual(["claude-unknown-9"]);
    expect(pricesWithOverride('{"claude-sonnet-5-5":{"input":1,"output":5}}')["claude-sonnet-5-5"]).toEqual({ input: 1, output: 5 });
    expect(() => pricesWithOverride('{"x":{"input":"cheap"}}')).toThrow(/numeric input and output/);
    expect(Object.keys(MODEL_PRICES_USD_PER_MTOK)).toContain("claude-opus-5-5");
  });
});

describe("AI usage is persisted per call (migration 122) and attributed to the job", () => {
  it("the metered client records model and tokens through the sink; a failing sink never fails the call", async () => {
    const repo = new InMemoryRepository();
    const meter = new AiUsageMeter({ sink: aiUsageSink(repo), workspaceOf: async () => "ws_pilot" });
    const client = { messages: { parse: async (b: { model: string }) => ({ model: b.model, usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 40 }, parsed_output: {} }) } } as unknown as ParserClient;
    const metered = meteredClient(client, meter, "extract");
    await meter.run({ jobId: "job_x" }, () => (metered.messages.parse as (b: object) => Promise<unknown>)({ model: "claude-sonnet-5-5" }));
    await meter.flush();
    expect(await repo.listAiUsage({ jobIds: ["job_x"] })).toEqual([expect.objectContaining({ job_id: "job_x", workspace_id: "ws_pilot", purpose: "extract", model: "claude-sonnet-5-5", input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 40 })]);

    const broken = new AiUsageMeter({ sink: async () => { throw new Error("db down"); } });
    const ok = meteredClient(client, broken, "extract");
    await expect((ok.messages.parse as (b: object) => Promise<unknown>)({ model: "claude-sonnet-5-5" })).resolves.toBeTruthy();
    await broken.flush();
  });
});

describe("a mock-mode deal is never real usage", { timeout: 60_000 }, () => {
  it("runs a simulated deal to paid; the repository loader puts it in the simulated bucket with its funnel", async () => {
    let t = Date.parse("2026-10-01T16:00:00Z");
    const { engine, repo } = createMockEngine({ now: () => new Date(t), stripe: simulatedStripe() });
    const deal = await engine.deal({ request: { what: "lunch catering", quantity: 40, unit: "people", date: "2026-10-09", area: "San Francisco, CA", requirements: [] }, budget_usd: 1200, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) });
    let cursor = 0;
    let board = await engine.getQuotes(deal.job_id);
    for (let i = 0; i < 200 && !(board.ready && !board.pending_questions.length); i++) {
      t += 15_000;
      cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
      board = await engine.getQuotes(deal.job_id);
      for (const q of board.pending_questions) await engine.answerSeller(deal.job_id, q.question_id, "Yes, plates for 40.");
    }
    const a = await engine.requestApproval(deal.job_id, board.recommended_quote_id!, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    await engine.pay(deal.job_id, board.recommended_quote_id!);
    const d = await loadMetricsDatasetFromRepo(repo, [deal.job_id]);
    const r = buildMetricsReport(d);
    expect(r.real.jobs).toBe(0);
    expect(r.simulated_reasons.mock_mode).toBe(1);
    expect(r.simulated.jobs).toBe(1);
    expect(r.simulated.sourcing.jobs_with_priced_quote).toBe(1);
    expect(r.simulated.response_total.contacted).toBe(fleetBusinesses().length);
    expect(r.simulated.funnel.reached.completed).toBe(1);
    // No event summary (which can carry a vendor's words) reaches the dataset.
    expect(d.events.every((e) => !("summary" in e.data) && !("text" in e.data))).toBe(true);
  });
});

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("metrics on Postgres (SQL loader, migrations 116 + 122)", { timeout: 60_000 }, () => {
  it("reads only the window's rows, never a simulated row in the real numbers, and the usage rows", async () => {
    const db = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    const u = Math.random().toString(36).slice(2, 8);
    const hex = (c: string) => `biz_${c.repeat(10)}${u.padEnd(6, "0").replace(/[^0-9a-f]/g, "a")}`;
    const ROLLBACK = new Error("rollback");
    try {
      await db.begin(async (tx) => {
        const sql = tx as unknown as postgres.Sql;
        const ws = `ws_mx_${u}`, wsTest = `ws_mxt_${u}`;
        await sql`insert into public.workspaces (id, name) values (${ws}, 'Pilot'), (${wsTest}, 'Demo')`;
        const job = async (id: string, w: string, mode: "live" | "mock") => { await sql`insert into public.jobs (id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until, workspace_id) values (${id}, ${(`X${id}`.toUpperCase().replace(/[^A-Z0-9]/g, "")).slice(-8)}, 'collecting', ${mode}, '{}', 50000, ${`haggle+${id}@x.test`}, 2, now() + interval '1 hour', ${w})`; };
        const vendor = async (j: string, b: string, simulated: boolean) => { await sql`insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status, contacted_at) values (${j}, ${b}, ${b}, ${`${b}@x.test`}, 'agent', ${simulated}, 'quoted', now())`; };
        let n = 0;
        const replyQuote = async (j: string, b: string, simulated: boolean) => {
          const m = `m_${u}_${++n}`;
          await sql`insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status, sender_trusted, simulated) values (${m}, ${j}, ${b}, 'in', 'reply', ${`em_${m}`}, 'done', true, ${simulated})`;
          await sql`insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source) values (${`q_${m}`}, ${j}, ${b}, ${m}, 1, 'current', '{}', 115000, null, true, '[]', true, 'email body')`;
        };
        const real = `job_mxr${u}`, mock = `job_mxm${u}`, test = `job_mxt${u}`;
        await job(real, ws, "live"); await vendor(real, hex("1"), false); await vendor(real, hex("2"), true);
        await replyQuote(real, hex("1"), false); await replyQuote(real, hex("2"), true);
        await sql`select public.haggle_append_event(${real}, 'quote', ${sql.json({ business_id: hex("1"), total_usd: 1150, summary: "vendor words never loaded" } as never)})`;
        await job(mock, ws, "mock"); await vendor(mock, hex("1"), false); await replyQuote(mock, hex("1"), false);
        await job(test, wsTest, "live"); await vendor(test, hex("1"), false);
        await markTest(sql, { kind: "workspace", id: wsTest }, true, "internal demo", "metrics test");
        await sql`insert into public.ai_usage_events (job_id, workspace_id, purpose, model, input_tokens, output_tokens) values (${real}, ${ws}, 'extract', 'claude-sonnet-5-5', 10000, 1000), (${mock}, ${ws}, 'extract', 'claude-sonnet-5-5', 99999, 9999)`;

        const d = await loadMetricsDataset(sql, { workspace: ws });
        expect(d.jobs.map((j) => j.id).sort()).toEqual([mock, real].sort()); // the test workspace's job is outside --workspace
        expect(d.events.find((e) => e.job_id === real && e.type === "quote")!.data).toEqual({ business_id: hex("1"), total_usd: 1150 });
        const r = buildMetricsReport(d);
        expect(r.real).toMatchObject({ jobs: 1, sourcing: { jobs_with_1_valid_quote: 1 }, response_total: { contacted: 1, replied: 1, quoted: 1 } });
        expect(r.real.ai).toMatchObject({ calls: 1, input_tokens: 10000, approx_usd: 0.03 });
        expect(r.simulated).toMatchObject({ jobs: 1, ai: { calls: 1 } });
        expect(r.excluded_in_real_jobs).toEqual({ simulated_businesses: 1, simulated_messages: 1, quotes_from_simulated_businesses: 1 });
        const all = buildMetricsReport(await loadMetricsDataset(sql, { since: new Date(Date.now() - 3_600_000) }));
        expect(all.simulated_reasons.test_workspace).toBeGreaterThanOrEqual(1);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    } finally {
      await db.end({ timeout: 5 });
    }
  });

  it("the Postgres repository appends and lists usage rows (append-only)", async () => {
    const repo = new PostgresRepository(PG_URL!);
    const job = `job_mxu${Math.random().toString(36).slice(2, 10)}`;
    try {
      await repo.recordAiUsage({ job_id: job, workspace_id: null, purpose: "strategist", model: "claude-sonnet-5-5", input_tokens: 5, output_tokens: 6, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
      expect(await repo.listAiUsage({ jobIds: [job] })).toEqual([expect.objectContaining({ job_id: job, purpose: "strategist", input_tokens: 5, output_tokens: 6, id: expect.any(Number) })]);
      expect(await repo.listAiUsage({ jobIds: [] })).toEqual([]);
    } finally {
      await (repo as unknown as { close?: () => Promise<void> }).close?.();
    }
  });
});
