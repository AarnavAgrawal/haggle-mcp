// Product usage metrics (sprint 5, E): computed only from rows the database holds (jobs, businesses,
// messages, quotes, questions, approvals, bookings, payment handoffs and receipts, payments, job
// events, operator reviews, quarantine decisions, held texts, test marks, AI usage). No in-memory
// counter is read: a restart changes nothing, and two operators running the report get the same numbers.
//
// SIMULATED vs REAL (the one rule; `classifyJob`, used for every number):
//   A job is REAL usage only if ALL hold:
//     1. jobs.mode = 'live'                          (never mock mode / the DEMO fleet server)
//     2. its workspace is not marked test            (analytics_test_marks, latest row wins)
//     3. the job itself is not marked test
//     4. it has at least one non-simulated business  (a live job that only reached the simulated
//                                                     fleet is a rehearsal, not a customer purchase)
//   Otherwise it is SIMULATED, with the first failing reason (mock_mode, test_workspace, test_job,
//   simulated_vendors_only). Inside a REAL job, rows that belong to a simulated business (its
//   messages, quotes, approvals, bookings, handoffs, and events naming it) and messages flagged
//   simulated are dropped as well; they are counted under `excluded` instead. Real numbers therefore
//   never include a simulated row. The SIMULATED bucket keeps every row of its jobs.
//
// Each bucket gets the same measures: sourcing completion, vendor response by channel, manual
// interventions, stage timings, the funnel (ops/traction.ts milestones), and AI usage with an
// approximate cost (ops/costs.ts). Read-only: the loaders only SELECT (SQL) or call repository reads.
import type { Sql } from "postgres";
import type { AiUsageRow, Repository } from "../store/types.ts";
import { summarizeCost, type CostSummary, type ModelPrice } from "./costs.ts";
import { buildFunnel, MILESTONES, type Funnel, type FunnelEvent } from "./traction.ts";

// ── dataset (what the loaders read; no message bodies, no vendor text) ──

export interface MJob { id: string; workspace_id: string; mode: "mock" | "live"; state: string; created_at: string; updated_at: string }
export interface MBusiness { job_id: string; business_id: string; channel: string; simulated: boolean; status: string; contacted_at: string | null; escalated_at: string | null }
export interface MMessage { job_id: string | null; business_id: string | null; direction: "in" | "out"; kind: string; channel: string; sender_trusted: boolean | null; simulated: boolean; created_at: string }
export interface MQuote { job_id: string; business_id: string; status: string; total_cents: number | null; compliant: boolean; sender_trusted: boolean; created_at: string }
export interface MQuestion { id: string; job_id: string; business_id: string; status: string; answered_at: string | null }
export interface MApproval { id: string; job_id: string; business_id: string; channel: string; status: string; decided_at: string | null; created_at: string }
export interface MBooking { job_id: string; business_id: string; approval_id: string; status: string; confirmed_at: string | null }
export interface MHandoff { id: string; job_id: string; business_id: string; status: string; confirmed_at: string | null }
export interface MReceipt { handoff_id: string; job_id: string; created_at: string }
export interface MPayment { job_id: string; business_id: string; status: string; simulated: boolean; rail: string }
/** Events with only the fields metrics read (never summaries or vendor text). */
export interface MEvent { job_id: string; seq: number; type: string; at: string; data: Record<string, unknown> }
export interface MReview { job_id: string | null; kind: string; status: string }
export interface MQuarantine { job_id: string | null; decision: string }
export interface MHeld { job_id: string }
export interface MTestMark { target_kind: "workspace" | "job"; target_id: string; marked: boolean }

export interface MetricsDataset {
  jobs: MJob[]; businesses: MBusiness[]; messages: MMessage[]; quotes: MQuote[]; questions: MQuestion[];
  approvals: MApproval[]; bookings: MBooking[]; handoffs: MHandoff[]; receipts: MReceipt[]; payments: MPayment[];
  events: MEvent[]; reviews: MReview[]; quarantine: MQuarantine[]; held_texts: MHeld[]; test_marks: MTestMark[];
  ai_usage: AiUsageRow[];
}

/** Event data keys metrics read; everything else (summaries, vendor words) is never loaded. */
export const EVENT_KEYS = ["to", "from", "status", "by", "kind", "question_id", "business_id", "approval_id", "total_usd", "reason", "cause"] as const;
const pickEventData = (d: Record<string, unknown>) => Object.fromEntries(EVENT_KEYS.filter((k) => d[k] !== undefined).map((k) => [k, d[k]]));

// ── the rule ──

export type SimulatedReason = "mock_mode" | "test_workspace" | "test_job" | "simulated_vendors_only";
export const SIMULATED_REASONS: Record<SimulatedReason, string> = {
  mock_mode: "mock mode (HAGGLE_MODE=mock: the simulated DEMO fleet, simulated approvals and payments)",
  test_workspace: "live job in a workspace an operator marked as test (traction.ts mark-test)",
  test_job: "live job an operator marked as test",
  simulated_vendors_only: "live job whose every business is simulated (no real vendor was involved)",
};

/** Current test marks (latest row per target wins; rows are given oldest first). */
export function testTargets(marks: MTestMark[]): { workspaces: Set<string>; jobs: Set<string> } {
  const last = new Map<string, boolean>();
  for (const m of marks) last.set(`${m.target_kind}:${m.target_id}`, m.marked);
  const pick = (kind: string) => new Set([...last].filter(([k, v]) => v && k.startsWith(`${kind}:`)).map(([k]) => k.slice(kind.length + 1)));
  return { workspaces: pick("workspace"), jobs: pick("job") };
}

/** THE simulated-vs-real rule (see the header). Null: real usage. */
export function classifyJob(job: Pick<MJob, "id" | "workspace_id" | "mode">, businesses: Pick<MBusiness, "simulated">[], marks: { workspaces: Set<string>; jobs: Set<string> }): SimulatedReason | null {
  if (job.mode !== "live") return "mock_mode";
  if (marks.workspaces.has(job.workspace_id)) return "test_workspace";
  if (marks.jobs.has(job.id)) return "test_job";
  if (!businesses.some((b) => !b.simulated)) return "simulated_vendors_only";
  return null;
}

// ── measures ──

export interface Dist { n: number; median_s: number | null; p90_s: number | null; mean_s: number | null }
export interface ChannelResponse { contacted: number; replied: number; quoted: number; reply_rate: number | null; quote_rate: number | null }
export interface BucketMetrics {
  jobs: number;
  by_state: Record<string, number>;
  sourcing: { min_valid_quotes: number; jobs_with_vendor_contacted: number; jobs_with_priced_quote: number; jobs_with_1_valid_quote: number; jobs_with_n_valid_quotes: number; rate_1_valid: number | null; rate_n_valid: number | null };
  response_by_channel: Record<string, ChannelResponse>;
  response_total: ChannelResponse;
  escalated_to_call: number;
  interventions: {
    total: number; per_job: number | null;
    operator_reviews_opened: number; operator_reviews_resolved: number; operator_reviews_by_kind: Record<string, number>;
    quarantine_released: number; quarantine_rejected: number;
    held_texts_released: number; held_texts_pending: number;
    human_answers_to_business: number; auto_answers_to_business: number;
    booked_attestations: number; bookings_confirmed_by_human_directly: number;
    operator_closed: number; operator_retries: number; operator_attention: number;
  };
  timings: { time_to_first_quote: Dist; time_to_approval: Dist; time_to_booking: Dist; total_job_duration: Dist };
  funnel: { reached: Funnel["reached"]; drop_off: { from: string; to: string; lost: number; rate: number | null }[]; stopped: Funnel["stopped"] };
  ai: CostSummary & { jobs_with_usage: number; approx_usd_per_job: number | null };
}

export interface MetricsReport {
  generated_at: string;
  window: { since: string | null; until: string | null; workspace: string | null };
  rule: string;
  real: BucketMetrics;
  simulated: BucketMetrics;
  simulated_reasons: Record<SimulatedReason, number>;
  excluded_in_real_jobs: { simulated_businesses: number; simulated_messages: number; quotes_from_simulated_businesses: number };
  ai_unattributed: CostSummary;
  pricing_note: string;
}

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
const secs = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 1000;
const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

export function dist(values: number[]): Dist {
  const v = values.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median_s: null, p90_s: null, mean_s: null };
  const q = (p: number) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)]!;
  const r = (n: number) => Math.round(n * 10) / 10;
  return { n: v.length, median_s: r(v.length % 2 ? v[(v.length - 1) / 2]! : (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2), p90_s: r(q(0.9)), mean_s: r(v.reduce((s, x) => s + x, 0) / v.length) };
}

const validQuote = (q: MQuote) => q.total_cents !== null && q.sender_trusted && q.compliant && q.status !== "withdrawn";

/** The measures over one bucket's rows (already filtered by the rule). */
export function computeBucket(d: MetricsDataset, opts: { minValidQuotes?: number; prices?: Record<string, ModelPrice> } = {}): BucketMetrics {
  const N = opts.minValidQuotes ?? 3;
  const by = <T extends { job_id: string | null }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) if (r.job_id) m.set(r.job_id, [...(m.get(r.job_id) ?? []), r]);
    return m;
  };
  const bizBy = by(d.businesses), quoteBy = by(d.quotes), apprBy = by(d.approvals), bookBy = by(d.bookings), evBy = by(d.events);
  const by_state: Record<string, number> = {};
  for (const j of d.jobs) by_state[j.state] = (by_state[j.state] ?? 0) + 1;

  // Sourcing completion: distinct businesses with a valid quote (priced, verified sender, meets every must).
  let contactedJobs = 0, priced = 0, v1 = 0, vN = 0;
  for (const j of d.jobs) {
    if ((bizBy.get(j.id) ?? []).some((b) => b.contacted_at)) contactedJobs++;
    const qs = quoteBy.get(j.id) ?? [];
    if (qs.some((q) => q.total_cents !== null && q.sender_trusted)) priced++;
    const valid = new Set(qs.filter(validQuote).map((q) => q.business_id)).size;
    if (valid >= 1) v1++;
    if (valid >= N) vN++;
  }

  // Response per vendor contact (one contact = one business on one job), by the channel it was reached on.
  const inbound = new Set(d.messages.filter((m) => m.direction === "in" && m.sender_trusted === true && m.kind !== "quarantine" && m.job_id && m.business_id).map((m) => `${m.job_id}|${m.business_id}`));
  const quoted = new Set(d.quotes.filter((q) => q.total_cents !== null && q.sender_trusted).map((q) => `${q.job_id}|${q.business_id}`));
  const answered = new Set(d.quotes.filter((q) => q.sender_trusted).map((q) => `${q.job_id}|${q.business_id}`));
  const resp: Record<string, ChannelResponse> = {};
  const tot = { contacted: 0, replied: 0, quoted: 0 };
  for (const b of d.businesses.filter((x) => x.contacted_at)) {
    const k = `${b.job_id}|${b.business_id}`;
    const c = (resp[b.channel] ??= { contacted: 0, replied: 0, quoted: 0, reply_rate: null, quote_rate: null });
    const replied = inbound.has(k) || answered.has(k);
    c.contacted++; tot.contacted++;
    if (replied) { c.replied++; tot.replied++; }
    if (quoted.has(k)) { c.quoted++; tot.quoted++; }
  }
  for (const c of Object.values(resp)) { c.reply_rate = rate(c.replied, c.contacted); c.quote_rate = rate(c.quoted, c.contacted); }

  // Manual interventions: every time a person (operator or the human) had to step in beyond approving.
  const ev = (type: string, f: (x: Record<string, unknown>) => boolean = () => true) => d.events.filter((e) => e.type === type && f(e.data));
  const autoAnswered = new Set(ev("reply", (x) => x.kind === "question_auto_answered").map((e) => String(e.data.question_id)));
  const byKind: Record<string, number> = {};
  for (const r of d.reviews) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const iv = {
    operator_reviews_opened: d.reviews.length,
    operator_reviews_resolved: d.reviews.filter((r) => r.status === "resolved").length,
    operator_reviews_by_kind: byKind,
    quarantine_released: d.quarantine.filter((q) => q.decision === "released").length,
    quarantine_rejected: d.quarantine.filter((q) => q.decision === "rejected").length,
    held_texts_released: ev("text_released").length,
    held_texts_pending: d.held_texts.length,
    human_answers_to_business: d.questions.filter((q) => q.status === "answered" && !autoAnswered.has(q.id)).length,
    auto_answers_to_business: d.questions.filter((q) => q.status === "answered" && autoAnswered.has(q.id)).length,
    booked_attestations: ev("booking", (x) => x.status === "confirmed" && x.by === "human_ack").length,
    bookings_confirmed_by_human_directly: new Set(ev("booking", (x) => x.status === "not_in_writing").map((e) => String(e.data.approval_id))).size,
    operator_closed: ev("operator_closed").length,
    operator_retries: ev("operator_retry_done").length,
    operator_attention: ev("operator_attention").length,
  };
  const total = iv.operator_reviews_opened + iv.quarantine_released + iv.quarantine_rejected + iv.held_texts_released + iv.human_answers_to_business + iv.booked_attestations + iv.bookings_confirmed_by_human_directly + iv.operator_closed + iv.operator_retries + iv.operator_attention;

  // Stage timings from each job's created_at.
  const ttq: number[] = [], tta: number[] = [], ttb: number[] = [], dur: number[] = [];
  for (const j of d.jobs) {
    const firstQuote = (quoteBy.get(j.id) ?? []).filter((q) => q.total_cents !== null && q.sender_trusted).map((q) => q.created_at).sort()[0];
    if (firstQuote) ttq.push(secs(j.created_at, firstQuote));
    const approved = (apprBy.get(j.id) ?? []).filter((a) => ["approved", "used"].includes(a.status) && a.decided_at).map((a) => a.decided_at!).sort()[0];
    if (approved) tta.push(secs(j.created_at, approved));
    const booked = (bookBy.get(j.id) ?? []).filter((b) => b.confirmed_at && ["confirmed"].includes(b.status)).map((b) => b.confirmed_at!).sort()[0];
    if (booked) ttb.push(secs(j.created_at, booked));
    if (TERMINAL.has(j.state)) {
      const end = (evBy.get(j.id) ?? []).filter((e) => e.type === "state" && TERMINAL.has(String(e.data.to))).map((e) => e.at).sort().at(-1) ?? j.updated_at;
      dur.push(secs(j.created_at, end));
    }
  }

  // Funnel and drop-off between consecutive milestones.
  const f = buildFunnel(d.jobs.map((j) => ({ id: j.id, state: j.state, events: (evBy.get(j.id) ?? []).sort((a, b) => a.seq - b.seq).map((e): FunnelEvent => ({ type: e.type, data: e.data })) })));
  const drop_off = MILESTONES.slice(1).map((m, i) => {
    const from = MILESTONES[i]!;
    const lost = f.reached[from] - f.reached[m];
    return { from, to: m, lost, rate: rate(lost, f.reached[from]) };
  });

  const ai = summarizeCost(d.ai_usage, opts.prices);
  const jobsWithUsage = new Set(d.ai_usage.map((r) => r.job_id).filter(Boolean)).size;
  return {
    jobs: d.jobs.length, by_state,
    sourcing: { min_valid_quotes: N, jobs_with_vendor_contacted: contactedJobs, jobs_with_priced_quote: priced, jobs_with_1_valid_quote: v1, jobs_with_n_valid_quotes: vN, rate_1_valid: rate(v1, d.jobs.length), rate_n_valid: rate(vN, d.jobs.length) },
    response_by_channel: resp,
    response_total: { ...tot, reply_rate: rate(tot.replied, tot.contacted), quote_rate: rate(tot.quoted, tot.contacted) },
    escalated_to_call: d.businesses.filter((b) => b.escalated_at).length,
    interventions: { total, per_job: d.jobs.length ? Math.round((total / d.jobs.length) * 100) / 100 : null, ...iv },
    timings: { time_to_first_quote: dist(ttq), time_to_approval: dist(tta), time_to_booking: dist(ttb), total_job_duration: dist(dur) },
    funnel: { reached: f.reached, drop_off, stopped: f.stopped },
    ai: { ...ai, jobs_with_usage: jobsWithUsage, approx_usd_per_job: d.jobs.length ? Math.round((ai.approx_usd / d.jobs.length) * 1e6) / 1e6 : null },
  };
}

/** Splits a dataset by the rule into the real and simulated buckets (real rows never include a simulated row). */
export function splitDataset(d: MetricsDataset): { real: MetricsDataset; simulated: MetricsDataset; reasons: Record<SimulatedReason, number>; excluded: MetricsReport["excluded_in_real_jobs"] } {
  const marks = testTargets(d.test_marks);
  const reasons: Record<SimulatedReason, number> = { mock_mode: 0, test_workspace: 0, test_job: 0, simulated_vendors_only: 0 };
  const realJobs = new Set<string>(), simJobs = new Set<string>();
  for (const j of d.jobs) {
    const r = classifyJob(j, d.businesses.filter((b) => b.job_id === j.id), marks);
    if (r) { reasons[r]++; simJobs.add(j.id); } else realJobs.add(j.id);
  }
  const simBiz = new Set(d.businesses.filter((b) => b.simulated && realJobs.has(b.job_id)).map((b) => `${b.job_id}|${b.business_id}`));
  const simApprovals = new Set(d.approvals.filter((a) => simBiz.has(`${a.job_id}|${a.business_id}`) || a.channel === "simulated").map((a) => a.id));
  const realRow = (r: { job_id: string | null; business_id?: string | null }) => !!r.job_id && realJobs.has(r.job_id) && !(r.business_id && simBiz.has(`${r.job_id}|${r.business_id}`));
  const realEvent = (e: MEvent) => realJobs.has(e.job_id) && !(typeof e.data.business_id === "string" && simBiz.has(`${e.job_id}|${e.data.business_id}`)) && !(typeof e.data.approval_id === "string" && simApprovals.has(e.data.approval_id));
  const handoffReal = new Set(d.handoffs.filter(realRow).map((h) => h.id));
  const inSim = (r: { job_id: string | null }) => !!r.job_id && simJobs.has(r.job_id);
  const pick = (keep: (r: { job_id: string | null; business_id?: string | null }) => boolean, ev: (e: MEvent) => boolean, receipts: (r: MReceipt) => boolean): MetricsDataset => ({
    jobs: d.jobs.filter((j) => keep({ job_id: j.id })),
    businesses: d.businesses.filter(keep), messages: d.messages.filter((m) => keep(m) && !(realJobs.has(m.job_id ?? "") && m.simulated)), quotes: d.quotes.filter(keep), questions: d.questions.filter(keep),
    approvals: d.approvals.filter((a) => keep(a) && !(realJobs.has(a.job_id) && simApprovals.has(a.id))), bookings: d.bookings.filter(keep), handoffs: d.handoffs.filter(keep), receipts: d.receipts.filter(receipts),
    payments: d.payments.filter((p) => keep(p) && !(realJobs.has(p.job_id) && p.simulated)), events: d.events.filter(ev),
    reviews: d.reviews.filter((r) => keep(r)), quarantine: d.quarantine.filter((q) => keep(q)), held_texts: d.held_texts.filter((h) => keep(h)), test_marks: [],
    ai_usage: d.ai_usage.filter((u) => keep({ job_id: u.job_id })),
  });
  return {
    real: pick(realRow, realEvent, (r) => handoffReal.has(r.handoff_id)),
    simulated: pick(inSim, (e) => simJobs.has(e.job_id), (r) => simJobs.has(r.job_id)),
    reasons,
    excluded: {
      simulated_businesses: simBiz.size,
      simulated_messages: d.messages.filter((m) => m.job_id && realJobs.has(m.job_id) && (m.simulated || (m.business_id && simBiz.has(`${m.job_id}|${m.business_id}`)))).length,
      quotes_from_simulated_businesses: d.quotes.filter((q) => simBiz.has(`${q.job_id}|${q.business_id}`)).length,
    },
  };
}

export const METRICS_RULE = "real = live mode AND workspace not marked test AND job not marked test AND at least one non-simulated business; inside real jobs, simulated businesses' rows and simulated messages are dropped";

export function buildMetricsReport(d: MetricsDataset, opts: { minValidQuotes?: number; prices?: Record<string, ModelPrice>; window?: MetricsReport["window"]; now?: Date } = {}): MetricsReport {
  const s = splitDataset(d);
  const known = new Set(d.jobs.map((j) => j.id));
  return {
    generated_at: (opts.now ?? new Date()).toISOString(),
    window: opts.window ?? { since: null, until: null, workspace: null },
    rule: METRICS_RULE,
    real: computeBucket(s.real, opts),
    simulated: computeBucket(s.simulated, opts),
    simulated_reasons: s.reasons,
    excluded_in_real_jobs: s.excluded,
    ai_unattributed: summarizeCost(d.ai_usage.filter((u) => !u.job_id || !known.has(u.job_id)), opts.prices),
    pricing_note: "AI cost is APPROXIMATE: recorded token counts x list prices (packages/engine/src/ops/costs.ts, docs/pilot-metrics.md); not an invoice.",
  };
}

// ── loaders ──

export interface MetricsWindow { since?: Date; until?: Date; workspace?: string }

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const isoN = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

/** Read-only SQL loader (the metrics script). Only SELECTs; jobs created in [since, until), optionally one workspace. */
export async function loadMetricsDataset(sql: Sql, w: MetricsWindow = {}): Promise<MetricsDataset> {
  const since = w.since ?? new Date(0);
  const until = w.until ?? new Date("9999-12-31T00:00:00Z");
  const jobs = (await sql`select id, workspace_id, mode, state, created_at, updated_at from public.jobs
    where created_at >= ${since} and created_at < ${until} ${w.workspace ? sql`and workspace_id = ${w.workspace}` : sql``} order by created_at, id`)
    .map((r) => ({ id: String(r.id), workspace_id: String(r.workspace_id), mode: r.mode as MJob["mode"], state: String(r.state), created_at: iso(r.created_at), updated_at: iso(r.updated_at) }));
  const ids = jobs.map((j) => j.id);
  const hasTable = async (t: string) => (await sql`select to_regclass(${`public.${t}`}) is not null as ok`)[0]?.ok === true;
  const [marksOn, usageOn, reviewsOn, quarantineOn, heldOn, bookingsOn, receiptsOn, handoffsOn] = await Promise.all(["analytics_test_marks", "ai_usage_events", "operator_reviews", "quarantine_resolutions", "held_texts", "bookings", "handoff_receipts", "payment_handoffs"].map(hasTable));
  const test_marks = marksOn ? (await sql`select target_kind, target_id, marked from public.analytics_test_marks order by marked_at, id`).map((r) => ({ target_kind: r.target_kind as MTestMark["target_kind"], target_id: String(r.target_id), marked: r.marked === true })) : [];
  if (!ids.length) return { jobs, businesses: [], messages: [], quotes: [], questions: [], approvals: [], bookings: [], handoffs: [], receipts: [], payments: [], events: [], reviews: [], quarantine: [], held_texts: [], test_marks, ai_usage: [] };
  const [businesses, messages, quotes, questions, approvals, bookings, handoffs, receipts, payments, events, reviews, quarantine, held, usage] = await Promise.all([
    sql`select job_id, business_id, channel, simulated, status, contacted_at, escalated_at from public.job_businesses where job_id = any(${ids})`,
    sql`select job_id, business_id, direction, kind, channel, sender_trusted, simulated, created_at from public.messages where job_id = any(${ids})`,
    sql`select job_id, business_id, status, total_cents, compliant, sender_trusted, created_at from public.quotes where job_id = any(${ids})`,
    sql`select id, job_id, business_id, status, answered_at from public.questions where job_id = any(${ids})`,
    sql`select id, job_id, business_id, channel, status, decided_at, created_at from public.approvals where job_id = any(${ids})`,
    bookingsOn ? sql`select job_id, business_id, approval_id, status, confirmed_at from public.bookings where job_id = any(${ids})` : Promise.resolve([]),
    handoffsOn ? sql`select id, job_id, business_id, status, confirmed_at from public.payment_handoffs where job_id = any(${ids})` : Promise.resolve([]),
    receiptsOn ? sql`select handoff_id, job_id, created_at from public.handoff_receipts where job_id = any(${ids})` : Promise.resolve([]),
    sql`select job_id, business_id, status, simulated, rail from public.payments where job_id = any(${ids})`,
    // Only the keys metrics read: event summaries can quote a vendor's words and are never loaded.
    sql`select job_id, seq, type, at, jsonb_strip_nulls(jsonb_build_object(${sql.unsafe(EVENT_KEYS.map((k) => `'${k}', data->'${k}'`).join(", "))})) as data from public.job_events where job_id = any(${ids}) order by job_id, seq`,
    reviewsOn ? sql`select job_id, kind, status from public.operator_reviews where job_id = any(${ids})` : Promise.resolve([]),
    quarantineOn ? sql`select job_id, decision from public.quarantine_resolutions where job_id = any(${ids})` : Promise.resolve([]),
    heldOn ? sql`select job_id from public.held_texts where job_id = any(${ids})` : Promise.resolve([]),
    usageOn ? sql`select * from public.ai_usage_events where job_id = any(${ids}) or (job_id is null and at >= ${since} and at < ${until}) order by at, id` : Promise.resolve([]),
  ]);
  type R = Record<string, unknown>;
  return {
    jobs,
    businesses: (businesses as R[]).map((r) => ({ job_id: String(r.job_id), business_id: String(r.business_id), channel: String(r.channel), simulated: r.simulated === true, status: String(r.status), contacted_at: isoN(r.contacted_at), escalated_at: isoN(r.escalated_at) })),
    messages: (messages as R[]).map((r) => ({ job_id: r.job_id === null ? null : String(r.job_id), business_id: r.business_id === null ? null : String(r.business_id), direction: r.direction as "in" | "out", kind: String(r.kind), channel: String(r.channel), sender_trusted: r.sender_trusted === null ? null : r.sender_trusted === true, simulated: r.simulated === true, created_at: iso(r.created_at) })),
    quotes: (quotes as R[]).map((r) => ({ job_id: String(r.job_id), business_id: String(r.business_id), status: String(r.status), total_cents: r.total_cents === null ? null : Number(r.total_cents), compliant: r.compliant === true, sender_trusted: r.sender_trusted === true, created_at: iso(r.created_at) })),
    questions: (questions as R[]).map((r) => ({ id: String(r.id), job_id: String(r.job_id), business_id: String(r.business_id), status: String(r.status), answered_at: isoN(r.answered_at) })),
    approvals: (approvals as R[]).map((r) => ({ id: String(r.id), job_id: String(r.job_id), business_id: String(r.business_id), channel: String(r.channel), status: String(r.status), decided_at: isoN(r.decided_at), created_at: iso(r.created_at) })),
    bookings: (bookings as R[]).map((r) => ({ job_id: String(r.job_id), business_id: String(r.business_id), approval_id: String(r.approval_id), status: String(r.status), confirmed_at: isoN(r.confirmed_at) })),
    handoffs: (handoffs as R[]).map((r) => ({ id: String(r.id), job_id: String(r.job_id), business_id: String(r.business_id), status: String(r.status), confirmed_at: isoN(r.confirmed_at) })),
    receipts: (receipts as R[]).map((r) => ({ handoff_id: String(r.handoff_id), job_id: String(r.job_id), created_at: iso(r.created_at) })),
    payments: (payments as R[]).map((r) => ({ job_id: String(r.job_id), business_id: String(r.business_id), status: String(r.status), simulated: r.simulated === true, rail: String(r.rail) })),
    events: (events as R[]).map((r) => ({ job_id: String(r.job_id), seq: Number(r.seq), type: String(r.type), at: iso(r.at), data: (r.data ?? {}) as Record<string, unknown> })),
    reviews: (reviews as R[]).map((r) => ({ job_id: r.job_id === null ? null : String(r.job_id), kind: String(r.kind), status: String(r.status) })),
    quarantine: (quarantine as R[]).map((r) => ({ job_id: r.job_id === null ? null : String(r.job_id), decision: String(r.decision) })),
    held_texts: (held as R[]).map((r) => ({ job_id: String(r.job_id) })),
    test_marks,
    ai_usage: (usage as R[]).map((r) => ({ id: Number(r.id), job_id: r.job_id === null ? null : String(r.job_id), workspace_id: r.workspace_id === null ? null : String(r.workspace_id), purpose: String(r.purpose), model: String(r.model), input_tokens: Number(r.input_tokens), output_tokens: Number(r.output_tokens), cache_creation_input_tokens: Number(r.cache_creation_input_tokens), cache_read_input_tokens: Number(r.cache_read_input_tokens), at: iso(r.at) })),
  };
}

export type MetricsRepo = Pick<Repository, "getJob" | "getBusinesses" | "listMessages" | "listQuotes" | "listQuestions" | "listEvents" | "getApproval" | "getLatestApproval" | "getBookingByApproval" | "getHandoffByApproval" | "getHandoffReceipt" | "getPaymentForJob" | "listReviews" | "listQuarantineResolutions" | "listAiUsage">;

/** The same dataset from repository reads (the in-memory store of the pilot benchmark; any repository). */
export async function loadMetricsDatasetFromRepo(repo: MetricsRepo, jobIds: string[]): Promise<MetricsDataset> {
  const d: MetricsDataset = { jobs: [], businesses: [], messages: [], quotes: [], questions: [], approvals: [], bookings: [], handoffs: [], receipts: [], payments: [], events: [], reviews: [], quarantine: [], held_texts: [], test_marks: [], ai_usage: [] };
  for (const id of jobIds) {
    const j = await repo.getJob(id);
    if (!j) continue;
    d.jobs.push({ id: j.id, workspace_id: j.workspace_id, mode: j.mode, state: j.state, created_at: j.created_at, updated_at: j.updated_at });
    for (const b of await repo.getBusinesses(id)) d.businesses.push({ job_id: id, business_id: b.business_id, channel: b.channel, simulated: b.simulated, status: b.status, contacted_at: b.contacted_at, escalated_at: b.escalated_at ?? null });
    for (const m of await repo.listMessages(id)) d.messages.push({ job_id: m.job_id, business_id: m.business_id, direction: m.direction, kind: m.kind, channel: m.channel, sender_trusted: m.sender_trusted, simulated: m.simulated, created_at: m.created_at });
    for (const q of await repo.listQuotes(id)) d.quotes.push({ job_id: q.job_id, business_id: q.business_id, status: q.status, total_cents: q.total_cents, compliant: q.compliant, sender_trusted: q.sender_trusted, created_at: q.created_at });
    for (const q of await repo.listQuestions(id)) d.questions.push({ id: q.id, job_id: q.job_id, business_id: q.business_id, status: q.status, answered_at: q.answered_at });
    const events = await repo.listEvents(id);
    for (const e of events) d.events.push({ job_id: id, seq: e.seq, type: e.type, at: e.at, data: pickEventData(e.data) });
    const approvalIds = new Set(events.map((e) => e.data.approval_id).filter((x): x is string => typeof x === "string"));
    const latest = await repo.getLatestApproval(id);
    if (latest) approvalIds.add(latest.id);
    for (const aid of approvalIds) {
      const a = await repo.getApproval(aid);
      if (!a || a.job_id !== id) continue;
      d.approvals.push({ id: a.id, job_id: a.job_id, business_id: a.business_id, channel: a.channel, status: a.status, decided_at: a.decided_at, created_at: a.created_at });
      const bk = await repo.getBookingByApproval(a.id);
      if (bk) d.bookings.push({ job_id: bk.job_id, business_id: bk.business_id, approval_id: bk.approval_id, status: bk.status, confirmed_at: bk.confirmed_at });
      const h = await repo.getHandoffByApproval(a.id);
      if (h) {
        d.handoffs.push({ id: h.id, job_id: h.job_id, business_id: h.business_id, status: h.status, confirmed_at: h.confirmed_at });
        const r = await repo.getHandoffReceipt(h.id);
        if (r) d.receipts.push({ handoff_id: r.handoff_id, job_id: r.job_id, created_at: r.created_at });
      }
    }
    const p = await repo.getPaymentForJob(id);
    if (p) d.payments.push({ job_id: p.job_id, business_id: p.business_id, status: p.status, simulated: p.simulated, rail: p.rail });
    for (const r of await repo.listReviews({ jobId: id, limit: 1000 })) d.reviews.push({ job_id: r.job_id, kind: r.kind, status: r.status });
    for (const q of await repo.listQuarantineResolutions({ jobId: id, limit: 1000 })) d.quarantine.push({ job_id: q.job_id, decision: q.decision });
  }
  d.ai_usage = (await repo.listAiUsage?.({ jobIds: d.jobs.map((j) => j.id) })) ?? [];
  return d;
}

// ── text report ──

const fmt = (v: number | null | undefined, unit = "") => (v === null || v === undefined ? "-" : `${v}${unit}`);
const pct = (v: number | null) => (v === null ? "-" : `${Math.round(v * 1000) / 10}%`);
const dur = (x: Dist) => (x.n ? `${fmtS(x.median_s)} (p90 ${fmtS(x.p90_s)}, n=${x.n})` : "-");
const fmtS = (s: number | null) => (s === null ? "-" : s < 120 ? `${s}s` : s < 7200 ? `${Math.round(s / 6) / 10}m` : `${Math.round(s / 360) / 10}h`);

/** Real and simulated side by side; real numbers never include simulated rows. */
export function metricsText(r: MetricsReport): string {
  const row = (label: string, real: string, sim: string) => `  ${label.padEnd(46)} ${real.padStart(18)}   ${sim.padStart(18)}`;
  const both = (label: string, f: (b: BucketMetrics) => string) => row(label, f(r.real), f(r.simulated));
  const channels = [...new Set([...Object.keys(r.real.response_by_channel), ...Object.keys(r.simulated.response_by_channel)])].sort();
  const ch = (b: BucketMetrics, c: string) => { const x = b.response_by_channel[c]; return x ? `${x.replied}/${x.contacted} r, ${x.quoted} q` : "-"; };
  const w = r.window;
  return [
    `Haggle usage metrics (${w.since ?? "start"} .. ${w.until ?? "now"}${w.workspace ? `, workspace ${w.workspace}` : ""}); generated ${r.generated_at}`,
    `Rule: ${r.rule}.`,
    row("", "REAL", "SIMULATED"),
    both("jobs", (b) => String(b.jobs)),
    both("jobs with a vendor contacted", (b) => String(b.sourcing.jobs_with_vendor_contacted)),
    both("jobs with >=1 priced quote", (b) => String(b.sourcing.jobs_with_priced_quote)),
    both("jobs with >=1 valid quote", (b) => `${b.sourcing.jobs_with_1_valid_quote} (${pct(b.sourcing.rate_1_valid)})`),
    both(`jobs with >=${r.real.sourcing.min_valid_quotes} valid quotes`, (b) => `${b.sourcing.jobs_with_n_valid_quotes} (${pct(b.sourcing.rate_n_valid)})`),
    both("vendor contacts replied / quoted", (b) => `${pct(b.response_total.reply_rate)} / ${pct(b.response_total.quote_rate)}`),
    ...channels.map((c) => both(`  by channel: ${c} (replied/contacted, quoted)`, (b) => ch(b, c))),
    both("escalated email -> call", (b) => String(b.escalated_to_call)),
    both("manual interventions (per job)", (b) => `${b.interventions.total} (${fmt(b.interventions.per_job)})`),
    both("  human answers to a business question", (b) => String(b.interventions.human_answers_to_business)),
    both("  BOOKED attestations / human-confirmed", (b) => `${b.interventions.booked_attestations} / ${b.interventions.bookings_confirmed_by_human_directly}`),
    both("  operator reviews opened / resolved", (b) => `${b.interventions.operator_reviews_opened} / ${b.interventions.operator_reviews_resolved}`),
    both("  quarantine released / rejected", (b) => `${b.interventions.quarantine_released} / ${b.interventions.quarantine_rejected}`),
    both("  held texts released / pending", (b) => `${b.interventions.held_texts_released} / ${b.interventions.held_texts_pending}`),
    both("  operator closed / retried / attention", (b) => `${b.interventions.operator_closed} / ${b.interventions.operator_retries} / ${b.interventions.operator_attention}`),
    both("time to first quote (median)", (b) => dur(b.timings.time_to_first_quote)),
    both("time to approval (median)", (b) => dur(b.timings.time_to_approval)),
    both("time to vendor-confirmed booking (median)", (b) => dur(b.timings.time_to_booking)),
    both("total job duration, finished jobs (median)", (b) => dur(b.timings.total_job_duration)),
    ...MILESTONES.map((m) => both(`funnel: reached ${m}`, (b) => String(b.funnel.reached[m]))),
    both("AI calls / tokens in+out", (b) => `${b.ai.calls} / ${b.ai.input_tokens + b.ai.cache_creation_input_tokens + b.ai.cache_read_input_tokens}+${b.ai.output_tokens}`),
    both("AI approx cost USD (per job)", (b) => `${b.ai.approx_usd.toFixed(4)} (${b.ai.approx_usd_per_job === null ? "-" : b.ai.approx_usd_per_job.toFixed(4)})`),
    `Simulated because: ${Object.entries(r.simulated_reasons).map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    `Dropped from real jobs: ${r.excluded_in_real_jobs.simulated_businesses} simulated businesses, ${r.excluded_in_real_jobs.simulated_messages} simulated messages, ${r.excluded_in_real_jobs.quotes_from_simulated_businesses} quotes from simulated businesses.`,
    `AI usage not tied to a job in this window: ${r.ai_unattributed.calls} calls, approx $${r.ai_unattributed.approx_usd.toFixed(4)}.${[...r.real.ai.unpriced_models, ...r.simulated.ai.unpriced_models].length ? ` Unpriced models (charged at the fallback price): ${[...new Set([...r.real.ai.unpriced_models, ...r.simulated.ai.unpriced_models])].join(", ")}.` : ""}`,
    r.pricing_note,
  ].join("\n");
}
