// SIMULATED pilot benchmark (sprint 5, E): N catering deals in MOCK mode, end to end, reproducible.
// Nothing is real: the mock engine (packages/engine/src/mock.ts) plays the six DEMO vendors, the
// human's approval is the simulated DEMO channel, and payment is the simulated Stripe rail. No
// provider, network or live database is touched. Results describe the software on scripted vendors,
// never real-world behaviour (docs/pilot-metrics.md).
//
//   node scripts/pilot-benchmark.ts [--n 10] [--seed 1] [--repo memory|pg] [--out <dir>] [--json]
//
// Each deal i draws its request from a seeded PRNG (seed, i): headcount, budget, event day, must-haves
// and which DEMO vendors are asked. A scripted reference agent then does what the tool descriptions
// say: deal -> wait_for_update (25 s long-polls, cursor passed back) -> answer_business for each open
// question (the user answers in chat: a human step) -> get_quotes once quotes are final -> approve the
// recommendation (the simulated human approves: a human step) -> pay. The engine clock is simulated
// (starts 2026-10-01T16:00Z), so outcomes, tool calls, human steps, output sizes and simulated
// durations are deterministic for a seed and comparable across commits (`fingerprint`); wall-clock
// latency is reported but excluded from the fingerprint.
//
// Verdict per deal, against an oracle independent of the engine's recommendation rule: a quote is
// ACCEPTABLE when it meets every requirement (as the scripted vendor states it), is within budget, isn't
// flagged unsafe (payment link, injected instructions, unverified sender), and its up-front amount
// (deposit, else the total) fits the per-payment ceiling. completed = an acceptable quote recommended,
// approved and paid; correct_escalation = none acceptable and the board hands the decision to the human;
// missed_option = one was acceptable but nothing was recommended; wrong_recommendation = the
// recommended quote wasn't acceptable; stalled = quotes never final. For escalations, the benchmark also
// checks that the board's next step names the cheapest quote that meets every requirement (even one
// over budget or the ceiling), so the human isn't left choosing without it. Safety: a paid quote
// without a recorded human approval of it, or a recommended or paid quote flagged unsafe.
//
// Output size: each tool's structuredContent is built with the same constructors the MCP tools use
// (src/views.ts: toDealBoardPlus for get_quotes/open_haggle, waitOutput for wait_for_update,
// dealStartedBoard and toApproval approximating deal/approve/pay). Chars are JSON chars;
// tokens are estimated at 4 chars/token. Content text and transport framing are not included.
//
// AI cost: mock mode makes no Claude calls, so recorded usage (migration 122 rows) is 0 by
// construction. `projected_live_ai` multiplies the replies a live server would send to Claude by a
// stated ASSUMPTION per call (not measured; see docs/pilot-metrics.md). --repo pg (optional) runs the
// same deals on the throwaway local Postgres named by HAGGLE_TEST_DATABASE_URL (localhost only;
// scripts/test-postgres.sh style), never a shared database.
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildMetricsReport, callCostUsd, createMockEngine, fleetBusinesses, InMemoryRepository, loadMetricsDatasetFromRepo, PostgresRepository, simulatedStripe, type DealBoardData, type Repository } from "@haggle/engine";
import { dealStartedBoard, requestDetails, toApproval, toDealBoardPlus, waitOutput } from "../src/views.ts";

export const BENCH_T0 = "2026-10-01T16:00:00Z";
/** wait_for_update's default timeout_s, the long-poll the reference agent uses. */
const POLL_S = 25;
const POLL_STEP_MS = 5_000;
const MAX_POLLS = 200;
/** ASSUMPTION for projected_live_ai (not measured): one extraction call per vendor reply on claude-sonnet-5-5. */
export const PROJECTION = { model: "claude-sonnet-5-5", input_tokens_per_reply: 4_000, output_tokens_per_reply: 800 };

export interface BenchOptions { n: number; seed: number; repo?: "memory" | "pg"; databaseUrl?: string }
export interface ToolCall { tool: string; chars: number; est_tokens: number; sim_ms: number; wall_ms: number }
export type Verdict = "completed" | "correct_escalation" | "missed_option" | "wrong_recommendation" | "stalled";
export interface DealResult {
  index: number;
  verdict: Verdict;
  /** Escalations only: whether the board's next step names the cheapest quote that meets every requirement (null: none does). */
  escalation_names_best: boolean | null;
  safety_violations: string[];
  request: { headcount: number; budget_usd: number; date: string; requirements: string[]; vendors: string[] };
  outcome: string;
  quotes: number;
  chosen: string | null;
  chosen_total_usd: number | null;
  tool_calls: number;
  human_steps: string[];
  output_chars: number;
  max_response_chars: number;
  by_tool: Record<string, { calls: number; chars: number; max_chars: number }>;
  sim_s: { first_quote: number | null; ready: number | null; approved: number | null; paid: number | null };
  wall_ms: number;
  vendor_replies: number;
  calls: ToolCall[];
}
export interface BenchResult {
  label: "SIMULATED (mock mode, DEMO vendors; not real-world evidence)";
  options: { n: number; seed: number; repo: "memory" | "pg"; t0: string };
  deals: DealResult[];
  summary: {
    outcomes: Record<string, number>;
    verdicts: Record<Verdict, number>;
    /** (completed + correct_escalation) / n: the deal ended where a careful buyer would. */
    correct_end_rate: number;
    escalations_naming_best: { ok: number; of: number };
    safety_violations: number;
    tool_calls: { mean: number; max: number };
    human_steps: { mean: number; max: number };
    output_chars: { mean: number; max_response: number; est_tokens_mean: number };
    by_tool: Record<string, { calls: number; mean_chars: number; max_chars: number }>;
    sim_minutes: { first_quote_median: number | null; ready_median: number | null; paid_median: number | null };
    wall_ms: { total: number; mean_per_deal: number; mean_per_tool_call: number };
    ai: { recorded_calls: number; recorded_approx_usd: number; projected_live_ai: { assumption: typeof PROJECTION; vendor_replies: number; approx_usd: number; approx_usd_per_deal: number } };
    metrics: { real_jobs: number; simulated_jobs: number; simulated_reasons: Record<string, number>; sourcing: unknown; response_total: unknown; funnel_reached: unknown; interventions_total: number };
  };
  /** sha256 over everything deterministic (wall-clock excluded): equal across runs and machines for the same code and seed. */
  fingerprint: string;
}

/** mulberry32: a tiny seeded PRNG (deterministic across platforms). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The request and vendor set for deal `i` of a seed (pure). */
export function scenario(seed: number, i: number) {
  const r = prng(seed * 100_003 + i * 7919 + 1);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const headcount = pick([25, 40, 60, 80, 120] as const);
  const budget_usd = headcount * pick([22, 28, 35] as const);
  const date = new Date(Date.parse(BENCH_T0) + (7 + Math.floor(r() * 15)) * 86_400_000).toISOString().slice(0, 10);
  const vegMin = Math.max(1, Math.round(headcount * pick([0.1, 0.2, 0.3] as const)));
  const requirements = [
    ...(r() < 0.8 ? [{ id: "veg", kind: "dietary" as const, text: `At least ${vegMin} vegetarian meals`, hard: true, min_count: vegMin }] : []),
    ...(r() < 0.7 ? [{ id: "delivery", kind: "delivery" as const, text: "Delivery included", hard: true }] : []),
  ];
  const fleet = fleetBusinesses();
  const order = fleet.map((b) => ({ b, k: r() })).sort((x, y) => x.k - y.k).map((x) => x.b);
  const vendors = order.slice(0, 3 + Math.floor(r() * (fleet.length - 2)));
  return { headcount, budget_usd, date, requirements, vendors };
}

const chars = (v: unknown) => JSON.stringify(v).length;
const median = (xs: number[]) => { const v = [...xs].sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2) : null; };
const r1 = (n: number) => Math.round(n * 10) / 10;

async function runDeal(i: number, seed: number, repo: Repository, wallStart: () => number): Promise<{ deal: DealResult; jobId: string }> {
  const s = scenario(seed, i);
  const t0 = Date.parse(BENCH_T0) + i * 86_400_000; // each deal on its own simulated day
  let t = t0;
  const { engine } = createMockEngine({ now: () => new Date(t), stripe: simulatedStripe(), repo });
  const calls: ToolCall[] = [];
  const human: string[] = [];
  const sim = { first_quote: null as number | null, ready: null as number | null, approved: null as number | null, paid: null as number | null };
  const since = () => Math.round((t - t0) / 1000);
  const tool = async <T>(name: string, f: () => Promise<{ out: unknown; value: T }>): Promise<T> => {
    const w0 = performance.now(), s0 = t;
    const { out, value } = await f();
    const c = chars(out);
    calls.push({ tool: name, chars: c, est_tokens: Math.ceil(c / 4), sim_ms: t - s0, wall_ms: Math.round((performance.now() - w0) * 10) / 10 });
    return value;
  };
  const request = { what: "team lunch catering", quantity: s.headcount, unit: "people", date: s.date, time: "12:00", area: "San Francisco, CA", venue: "500 Howard St", requirements: s.requirements };
  const wall0 = wallStart();

  const dealRes = await tool("deal", async () => {
    const r = await engine.deal({ request, budget_usd: s.budget_usd, businesses: s.vendors.map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) });
    const b = await engine.getQuotes(r.job_id).catch(() => null);
    const out = dealStartedBoard(r as never, b, request as never, "mock", { request_details: requestDetails({ job: { request: (b?.job.request ?? request) as never, budget_usd: s.budget_usd } }, "request"), next: `Deal started; the board updates by itself. Call wait_for_update(job_id='${r.job_id}') to follow it.` });
    return { out, value: r };
  });
  const jobId = dealRes.job_id;
  let cursor = 0;
  let board: DealBoardData = await engine.getQuotes(jobId);
  for (let polls = 0; polls < MAX_POLLS; polls++) {
    const w = await tool("wait_for_update", async () => {
      // One long-poll: returns at the first change, else after POLL_S (simulated time).
      let res = await engine.waitForUpdate(jobId, cursor, 0);
      for (let waited = 0; res.updates.length === 0 && waited < POLL_S * 1000; waited += POLL_STEP_MS) {
        t += POLL_STEP_MS;
        res = await engine.waitForUpdate(jobId, cursor, 0);
      }
      return { out: waitOutput(res, cursor, { until: "any_change", timeoutS: POLL_S }).structured, value: res };
    });
    cursor = Number(w.cursor);
    if (sim.first_quote === null && w.updates.some((u) => u.type === "quote" && (u as { total_usd: number | null }).total_usd !== null)) sim.first_quote = since();
    board = await engine.getQuotes(jobId);
    // Open business questions: the agent asks the user in chat, then relays the answer.
    for (const q of board.pending_questions) {
      human.push("chat: answers a vendor question");
      await tool("answer_business", async () => {
        const out = await engine.answerSeller(jobId, q.question_id, `Yes: ${s.headcount} people, plates and utensils included.`);
        return { out, value: null };
      });
    }
    if (board.ready && !board.pending_questions.length) break;
    if (["paid", "confirmed", "cancelled", "failed"].includes(board.job.state)) break;
  }
  sim.ready = board.ready ? since() : null;
  board = await tool("get_quotes", async () => {
    const b = await engine.getQuotes(jobId);
    return { out: toDealBoardPlus(b, "mock"), value: b };
  });
  const quotes = board.quotes.filter((q) => q.status === "current" && q.total_usd !== null).length;
  const rec = board.recommended_quote_id ? board.quotes.find((q) => q.quote_id === board.recommended_quote_id) ?? null : null;
  // The oracle (see the header): from each quote's stated facts, not from the engine's recommendation.
  const UNSAFE = ["external_payment_link", "prompt_injection", "unverified_sender"];
  const current = board.quotes.filter((q) => q.status === "current" && q.total_usd !== null);
  const ceiling = board.payment_ceiling_usd ?? Infinity;
  const meets = (q: (typeof current)[number]) => q.meets_requirements === true && !q.flags.some((f) => UNSAFE.includes(f));
  const acceptable = (q: (typeof current)[number]) => meets(q) && q.total_usd! <= s.budget_usd && (q.deposit_usd ?? q.total_usd!) <= ceiling;
  const anyAcceptable = current.some(acceptable);
  const cheapestMeeting = current.filter(meets).sort((a, b) => a.total_usd! - b.total_usd!)[0] ?? null;
  const verdict: Verdict = !board.ready ? "stalled" : rec ? (acceptable(rec as never) ? "completed" : "wrong_recommendation") : anyAcceptable ? "missed_option" : "correct_escalation";
  const escalation_names_best = verdict === "correct_escalation" ? (cheapestMeeting ? board.next.includes(cheapestMeeting.business) : null) : null;
  const safety: string[] = [];
  if (rec && rec.flags.some((f) => UNSAFE.includes(f))) safety.push(`recommended an unsafe quote (${rec.business})`);
  let outcome = board.job.state as string;
  if (rec) {
    human.push("approves the recommended quote (simulated DEMO human)");
    await tool("approve", async () => {
      const a = await engine.requestApproval(jobId, rec.quote_id, "simulated");
      await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
      const b = await engine.getQuotes(jobId);
      return { out: toApproval(b, rec.quote_id, "approved", "mock", { next: "Call pay(job_id, quote_id)." }), value: null };
    });
    sim.approved = since();
    await tool("pay", async () => {
      const p = await engine.pay(jobId, rec.quote_id);
      const b = await engine.getQuotes(jobId);
      return { out: toApproval(b, rec.quote_id, p.status === "paid" ? "paid" : "approved", "mock", { next: "Done." }), value: null };
    });
    const job = await engine.loadJob(jobId);
    outcome = job.state;
    if (job.state === "paid") sim.paid = since();
    if (job.state === "paid") {
      const a = await repo.getLatestApproval(jobId);
      if (!a || a.quote_id !== rec.quote_id || !["approved", "used"].includes(a.status)) safety.push("paid without a recorded human approval of that quote");
    }
  } else if (outcome !== "failed") outcome = `${outcome} (nothing approvable)`;
  // A completed verdict needs the payment too.
  const finalVerdict: Verdict = verdict === "completed" && outcome !== "paid" ? "stalled" : verdict;
  const messages = await repo.listMessages(jobId);
  const by_tool: DealResult["by_tool"] = {};
  for (const c of calls) {
    const b = (by_tool[c.tool] ??= { calls: 0, chars: 0, max_chars: 0 });
    b.calls++; b.chars += c.chars; b.max_chars = Math.max(b.max_chars, c.chars);
  }
  return {
    jobId,
    deal: {
      index: i, verdict: finalVerdict, escalation_names_best, safety_violations: safety,
      request: { headcount: s.headcount, budget_usd: s.budget_usd, date: s.date, requirements: s.requirements.map((x) => x.text), vendors: s.vendors.map((v) => v.name) },
      outcome, quotes, chosen: rec?.business ?? null, chosen_total_usd: rec?.total_usd ?? null,
      tool_calls: calls.length, human_steps: human, output_chars: calls.reduce((n, c) => n + c.chars, 0), max_response_chars: Math.max(...calls.map((c) => c.chars)),
      by_tool, sim_s: sim, wall_ms: Math.round(wallStart() - wall0), vendor_replies: messages.filter((m) => m.direction === "in" && m.business_id).length, calls,
    },
  };
}

function assertLocalDb(url: string) {
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("--repo pg needs HAGGLE_TEST_DATABASE_URL on localhost (a throwaway database with the migrations applied); mock data never goes to a shared database");
}

export async function runPilotBenchmark(o: BenchOptions): Promise<BenchResult> {
  if (!Number.isInteger(o.n) || o.n < 1 || o.n > 500) throw new Error("--n must be 1-500");
  const kind = o.repo ?? "memory";
  let repo: Repository;
  if (kind === "pg") {
    if (!o.databaseUrl) throw new Error("--repo pg needs HAGGLE_TEST_DATABASE_URL (a throwaway local Postgres with the migrations applied)");
    assertLocalDb(o.databaseUrl);
    repo = new PostgresRepository(o.databaseUrl, { max: 2 });
  } else repo = new InMemoryRepository();
  const deals: DealResult[] = [];
  const jobIds: string[] = [];
  const wall = () => performance.now();
  const w0 = wall();
  try {
    for (let i = 0; i < o.n; i++) {
      const { deal, jobId } = await runDeal(i, o.seed, repo, wall);
      deals.push(deal);
      jobIds.push(jobId);
    }
    const totalWall = wall() - w0;
    const metrics = buildMetricsReport(await loadMetricsDatasetFromRepo(repo, jobIds));
    const replies = deals.reduce((n, d) => n + d.vendor_replies, 0);
    const projected = callCostUsd({ model: PROJECTION.model, input_tokens: PROJECTION.input_tokens_per_reply * replies, output_tokens: PROJECTION.output_tokens_per_reply * replies, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }).usd;
    const outcomes: Record<string, number> = {};
    for (const d of deals) outcomes[d.outcome] = (outcomes[d.outcome] ?? 0) + 1;
    const by_tool: BenchResult["summary"]["by_tool"] = {};
    for (const d of deals) for (const [k, v] of Object.entries(d.by_tool)) {
      const b = (by_tool[k] ??= { calls: 0, mean_chars: 0, max_chars: 0 });
      b.mean_chars = (b.mean_chars * b.calls + v.chars) / (b.calls + v.calls);
      b.calls += v.calls;
      b.max_chars = Math.max(b.max_chars, v.max_chars);
    }
    for (const b of Object.values(by_tool)) b.mean_chars = Math.round(b.mean_chars);
    const mean = (f: (d: DealResult) => number) => r1(deals.reduce((n, d) => n + f(d), 0) / deals.length);
    const toMin = (v: number | null) => (v === null ? null : r1(v / 60));
    const verdicts: Record<Verdict, number> = { completed: 0, correct_escalation: 0, missed_option: 0, wrong_recommendation: 0, stalled: 0 };
    for (const d of deals) verdicts[d.verdict]++;
    const esc = deals.filter((d) => d.escalation_names_best !== null);
    const summary: BenchResult["summary"] = {
      outcomes,
      verdicts,
      correct_end_rate: Math.round(((verdicts.completed + verdicts.correct_escalation) / deals.length) * 1000) / 1000,
      escalations_naming_best: { ok: esc.filter((d) => d.escalation_names_best).length, of: esc.length },
      safety_violations: deals.reduce((n, d) => n + d.safety_violations.length, 0),
      tool_calls: { mean: mean((d) => d.tool_calls), max: Math.max(...deals.map((d) => d.tool_calls)) },
      human_steps: { mean: mean((d) => d.human_steps.length), max: Math.max(...deals.map((d) => d.human_steps.length)) },
      output_chars: { mean: mean((d) => d.output_chars), max_response: Math.max(...deals.map((d) => d.max_response_chars)), est_tokens_mean: Math.ceil(mean((d) => d.output_chars) / 4) },
      by_tool,
      sim_minutes: { first_quote_median: toMin(median(deals.flatMap((d) => (d.sim_s.first_quote === null ? [] : [d.sim_s.first_quote])))), ready_median: toMin(median(deals.flatMap((d) => (d.sim_s.ready === null ? [] : [d.sim_s.ready])))), paid_median: toMin(median(deals.flatMap((d) => (d.sim_s.paid === null ? [] : [d.sim_s.paid])))) },
      wall_ms: { total: Math.round(totalWall), mean_per_deal: Math.round(totalWall / deals.length), mean_per_tool_call: r1(totalWall / deals.reduce((n, d) => n + d.tool_calls, 0)) },
      ai: { recorded_calls: metrics.simulated.ai.calls + metrics.real.ai.calls, recorded_approx_usd: metrics.simulated.ai.approx_usd + metrics.real.ai.approx_usd, projected_live_ai: { assumption: PROJECTION, vendor_replies: replies, approx_usd: Math.round(projected * 10_000) / 10_000, approx_usd_per_deal: Math.round((projected / deals.length) * 10_000) / 10_000 } },
      metrics: { real_jobs: metrics.real.jobs, simulated_jobs: metrics.simulated.jobs, simulated_reasons: metrics.simulated_reasons, sourcing: metrics.simulated.sourcing, response_total: metrics.simulated.response_total, funnel_reached: metrics.simulated.funnel.reached, interventions_total: metrics.simulated.interventions.total },
    };
    const options = { n: o.n, seed: o.seed, repo: kind, t0: BENCH_T0 };
    return { label: "SIMULATED (mock mode, DEMO vendors; not real-world evidence)", options, deals, summary, fingerprint: fingerprint({ options, deals, summary }) };
  } finally {
    if (repo instanceof PostgresRepository) await repo.close();
  }
}

/** Everything except wall-clock time. */
export function deterministicView(r: Pick<BenchResult, "options" | "deals" | "summary">) {
  const { wall_ms: _w, ...summary } = r.summary;
  return { options: { ...r.options, repo: undefined }, summary, deals: r.deals.map(({ wall_ms: _d, calls, ...d }) => ({ ...d, calls: calls.map(({ wall_ms: _c, ...c }) => c) })) };
}
export const fingerprint = (r: Pick<BenchResult, "options" | "deals" | "summary">) => createHash("sha256").update(JSON.stringify(deterministicView(r))).digest("hex").slice(0, 16);

export function benchmarkMarkdown(r: BenchResult): string {
  const s = r.summary;
  return [
    `# Pilot benchmark: ${r.label}`,
    "",
    `n=${r.options.n}, seed=${r.options.seed}, repo=${r.options.repo}, simulated clock from ${r.options.t0}. Fingerprint \`${r.fingerprint}\` (equal across runs for the same code and seed; wall-clock excluded).`,
    "",
    "| Measure | Value |",
    "| --- | --- |",
    `| Outcomes | ${Object.entries(s.outcomes).map(([k, v]) => `${k}: ${v}`).join(", ")} |`,
    `| Verdicts (oracle: requirements met, within budget and ceiling, not unsafe) | ${Object.entries(s.verdicts).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ")} |`,
    `| Deals that ended where a careful buyer would (completed + correct escalation) | ${Math.round(s.correct_end_rate * 100)}% |`,
    `| Escalations whose next step names the cheapest quote meeting every requirement | ${s.escalations_naming_best.ok}/${s.escalations_naming_best.of} |`,
    `| Safety violations (unapproved payment, unsafe quote recommended or paid) | ${s.safety_violations} |`,
    `| Agent tool calls per deal (mean / max) | ${s.tool_calls.mean} / ${s.tool_calls.max} |`,
    `| Human steps per deal (mean / max) | ${s.human_steps.mean} / ${s.human_steps.max} |`,
    `| Output per deal, structuredContent chars (mean; ~tokens) | ${s.output_chars.mean} (~${s.output_chars.est_tokens_mean}) |`,
    `| Largest single response (chars) | ${s.output_chars.max_response} |`,
    `| Simulated minutes to first quote / quotes final / paid (median) | ${s.sim_minutes.first_quote_median ?? "-"} / ${s.sim_minutes.ready_median ?? "-"} / ${s.sim_minutes.paid_median ?? "-"} |`,
    `| Wall-clock ms per deal / per tool call (mean; machine-dependent) | ${s.wall_ms.mean_per_deal} / ${s.wall_ms.mean_per_tool_call} |`,
    `| Recorded Claude calls / approx USD | ${s.ai.recorded_calls} / ${s.ai.recorded_approx_usd.toFixed(4)} (mock mode makes no Claude calls) |`,
    `| Projected live AI USD per deal (ASSUMPTION: ${s.ai.projected_live_ai.assumption.input_tokens_per_reply} in + ${s.ai.projected_live_ai.assumption.output_tokens_per_reply} out tokens per vendor reply, ${s.ai.projected_live_ai.assumption.model}; not measured) | ${s.ai.projected_live_ai.approx_usd_per_deal} |`,
    `| Metrics rule check: real / simulated jobs | ${s.metrics.real_jobs} / ${s.metrics.simulated_jobs} |`,
    "",
    "| Tool | Calls | Mean chars | Max chars |",
    "| --- | --- | --- | --- |",
    ...Object.entries(s.by_tool).map(([k, v]) => `| ${k} | ${v.calls} | ${v.mean_chars} | ${v.max_chars} |`),
    "",
    "| # | Headcount | Budget | Vendors | Outcome | Verdict | Quotes | Chosen | Tool calls | Human steps | Output chars |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...r.deals.map((d) => `| ${d.index} | ${d.request.headcount} | $${d.request.budget_usd} | ${d.request.vendors.length} | ${d.outcome} | ${d.verdict}${d.escalation_names_best === false ? " (best option not named)" : ""} | ${d.quotes} | ${d.chosen ? `${d.chosen} $${d.chosen_total_usd}` : "-"} | ${d.tool_calls} | ${d.human_steps.length} | ${d.output_chars} |`),
    "",
  ].join("\n");
}

const arg = (argv: string[], name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

/** Validate the command line (pure). */
export function planBenchmark(argv: string[]): BenchOptions & { out?: string; json: boolean } {
  const valued = ["--n", "--seed", "--repo", "--out"];
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("--") && a !== "--json" && !valued.includes(a)) throw new Error(`unknown option ${a} (use --n N, --seed S, --repo memory|pg, --out DIR, --json)`);
    if (!a.startsWith("--") && !valued.includes(argv[i - 1] ?? "")) throw new Error(`unexpected argument ${a}`);
  }
  const n = Number(arg(argv, "n") ?? 10);
  const seed = Number(arg(argv, "seed") ?? 1);
  const repo = arg(argv, "repo") ?? "memory";
  if (!Number.isInteger(n) || n < 1 || n > 500) throw new Error("--n must be 1-500");
  if (!Number.isInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
  if (repo !== "memory" && repo !== "pg") throw new Error("--repo must be memory or pg");
  const out = arg(argv, "out");
  return { n, seed, repo, json: argv.includes("--json"), ...(out ? { out } : {}) };
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planBenchmark(argv);
  const url = process.env.HAGGLE_TEST_DATABASE_URL;
  const r = await runPilotBenchmark({ ...cmd, ...(cmd.repo === "pg" && url ? { databaseUrl: url } : {}) });
  const md = benchmarkMarkdown(r);
  if (cmd.out) {
    mkdirSync(cmd.out, { recursive: true });
    const base = `pilot-benchmark-seed${r.options.seed}-n${r.options.n}`;
    writeFileSync(join(cmd.out, `${base}.json`), JSON.stringify(r, null, 2));
    writeFileSync(join(cmd.out, `${base}.md`), md);
  }
  console.log(cmd.json ? JSON.stringify(r, null, 2) : md);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/pilot-benchmark.ts")) {
  main().catch((e) => {
    console.error(`pilot-benchmark failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
