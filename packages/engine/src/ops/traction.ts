// Pilot traction and abandonment (sprint 4, E): read-only, from what the database can verify.
//
// Traction (migration 116's analytics views): only LIVE jobs, outside workspaces/jobs an operator
// marked as test, with non-simulated businesses. A reply counts only from a verified sender, an
// approval only from a human (never the mock simulated channel), a booking only when the business
// confirmed it in writing, a payment only as "customer reported" (manual handoff) or "vendor verified"
// (the business confirmed receipt). Card charges count only if they moved real money; the schema
// allows only Stripe test mode today, so that number is 0 by construction.
//
// Abandonment funnel: derived from each job's own job_events (no extra tracking): the furthest
// milestone the job reached, and for a job that didn't complete, where it stopped.
import postgres, { type Sql } from "postgres";

/** A one-connection client for the operator script (reads the analytics views; writes only test marks). */
export function analyticsSql(url: string): Sql {
  return postgres(url, { max: 1, idle_timeout: 5, onnotice: () => {} });
}

export type TestTarget = { kind: "workspace" | "job"; id: string };

/** Marks (or unmarks) a workspace or job as test: append-only; the latest row per target wins. */
export async function markTest(sql: Sql, t: TestTarget, marked: boolean, reason: string, by: string): Promise<void> {
  const exists = t.kind === "workspace" ? await sql`select 1 from public.workspaces where id = ${t.id}` : await sql`select 1 from public.jobs where id = ${t.id}`;
  if (!exists.length) throw new Error(`no ${t.kind} ${t.id}`);
  await sql`insert into public.analytics_test_marks (target_kind, target_id, marked, reason, marked_by) values (${t.kind}, ${t.id}, ${marked}, ${reason}, ${by})`;
}

export const TRACTION_METRICS = [
  "deals_created", "deals_with_real_vendor_contacted", "vendors_contacted", "distinct_vendors_contacted", "real_replies", "vendors_replied",
  "quotes", "deals_with_quote", "human_approvals", "bookings_vendor_confirmed", "bookings_human_confirmed_only",
  "customer_reported_payments", "customer_reported_cents", "vendor_verified_receipts", "vendor_verified_cents", "live_card_payments",
] as const;
export type TractionMetric = (typeof TRACTION_METRICS)[number];

/** What each number means, printed with the report so nobody reads more into it. */
export const TRACTION_DEFINITIONS: Record<TractionMetric, string> = {
  deals_created: "live jobs outside test workspaces/jobs",
  deals_with_real_vendor_contacted: "of those, jobs where at least one non-simulated business was contacted",
  vendors_contacted: "non-simulated businesses contacted (per job)",
  distinct_vendors_contacted: "distinct non-simulated businesses contacted",
  real_replies: "inbound replies from verified senders at non-simulated businesses",
  vendors_replied: "businesses (per job) that sent at least one verified reply",
  quotes: "priced quotes from verified senders at non-simulated businesses (revisions included)",
  deals_with_quote: "jobs with at least one such quote",
  human_approvals: "approvals a human gave (approved or used; never the simulated channel)",
  bookings_vendor_confirmed: "bookings the business confirmed in writing",
  bookings_human_confirmed_only: "bookings the human confirmed directly with a business Haggle couldn't get in writing (not vendor-verified)",
  customer_reported_payments: "manual payments the customer reported making (not verified by Haggle)",
  customer_reported_cents: "their total, in cents",
  vendor_verified_receipts: "payments the business itself confirmed receiving",
  vendor_verified_cents: "their total, in cents",
  live_card_payments: "card charges that moved real money (the schema only allows Stripe test mode: always 0)",
};

export type Traction = Record<TractionMetric, number>;
export interface Excluded { mock_jobs: number; live_jobs_marked_test: number; simulated_vendors_in_real_jobs: number; simulated_or_test_payments: number; test_workspaces: number; test_jobs: number }

export async function loadTraction(sql: Sql): Promise<{ traction: Traction; excluded: Excluded }> {
  const [t] = await sql`select * from public.analytics_traction`;
  const [x] = await sql`select * from public.analytics_excluded`;
  const num = (r: Record<string, unknown> | undefined, k: string) => Number(r?.[k] ?? 0);
  return {
    traction: Object.fromEntries(TRACTION_METRICS.map((k) => [k, num(t, k)])) as Traction,
    excluded: { mock_jobs: num(x, "mock_jobs"), live_jobs_marked_test: num(x, "live_jobs_marked_test"), simulated_vendors_in_real_jobs: num(x, "simulated_vendors_in_real_jobs"), simulated_or_test_payments: num(x, "simulated_or_test_payments"), test_workspaces: num(x, "test_workspaces"), test_jobs: num(x, "test_jobs") },
  };
}

// ── abandonment funnel ──

/** Milestones in order; a job's stage is the furthest it reached. */
export const MILESTONES = ["created", "contacted", "replied", "quoted", "approval_requested", "approved", "booked", "payment_reported", "completed"] as const;
export type Milestone = (typeof MILESTONES)[number];

/** Where a job that didn't complete stopped (the milestone it never reached). */
export const STOP_REASON: Record<Exclude<Milestone, "completed">, string> = {
  created: "no vendor contacted",
  contacted: "no replies",
  replied: "replies but no priced quote",
  quoted: "no compliant quote approved for the human (no approval requested)",
  approval_requested: "approval pending (the human hasn't approved)",
  approved: "booking unconfirmed (the business hasn't confirmed the approved terms)",
  booked: "handoff stalled (the customer hasn't reported paying)",
  payment_reported: "payment not verified (the business hasn't confirmed receipt)",
};

export interface FunnelEvent { type: string; data: Record<string, unknown> }
export interface FunnelJob { id: string; state: string; events: FunnelEvent[] }

const reached = (events: FunnelEvent[], states: string[]) => events.some((e) => e.type === "state" && states.includes(String(e.data.to)));

/** The furthest milestone one job reached, from its events alone. */
export function jobMilestone(j: FunnelJob): Milestone {
  const ev = j.events;
  const has = (type: string, f: (d: Record<string, unknown>) => boolean = () => true) => ev.some((e) => e.type === type && f(e.data));
  // completed: the business confirmed receipt, a confirm-only order went through, or a card charge settled.
  if (has("payment", (d) => d.status === "settled_verified") || reached(ev, ["confirmed", "paid"])) return "completed";
  if (has("payment", (d) => d.status === "human_reported_paid")) return "payment_reported";
  if (has("booking", (d) => d.status === "confirmed" || d.status === "not_in_writing")) return "booked";
  if (reached(ev, ["paying"]) || has("booking") || has("approval_verified")) return "approved";
  if (has("approval_requested") || reached(ev, ["awaiting_approval"])) return "approval_requested";
  if (has("quote", (d) => d.total_usd !== null && d.total_usd !== undefined)) return "quoted";
  if (has("quote") || has("question")) return "replied";
  if (reached(ev, ["collecting", "negotiating"]) || has("rfqs_sent")) return "contacted";
  return "created";
}

export interface FunnelRow { job_id: string; state: string; milestone: Milestone; stopped_at: string | null; ended: "open" | "cancelled" | "failed" | "done" }
export interface Funnel {
  jobs: number;
  /** How many jobs reached at least each milestone. */
  reached: Record<Milestone, number>;
  /** Where the jobs that didn't complete stopped, split by open vs ended (cancelled/failed). */
  stopped: { reason: string; open: number; ended: number }[];
  rows: FunnelRow[];
}

export function buildFunnel(jobs: FunnelJob[]): Funnel {
  const rows: FunnelRow[] = jobs.map((j) => {
    const m = jobMilestone(j);
    const ended = m === "completed" ? "done" : j.state === "cancelled" ? "cancelled" : j.state === "failed" ? "failed" : "open";
    return { job_id: j.id, state: j.state, milestone: m, stopped_at: m === "completed" ? null : STOP_REASON[m], ended };
  });
  const idx = (m: Milestone) => MILESTONES.indexOf(m);
  const reachedCounts = Object.fromEntries(MILESTONES.map((m) => [m, rows.filter((r) => idx(r.milestone) >= idx(m)).length])) as Record<Milestone, number>;
  const stopped = Object.values(STOP_REASON).map((reason) => ({ reason, open: rows.filter((r) => r.stopped_at === reason && r.ended === "open").length, ended: rows.filter((r) => r.stopped_at === reason && r.ended !== "open").length })).filter((s) => s.open + s.ended > 0);
  return { jobs: rows.length, reached: reachedCounts, stopped, rows };
}

/** The funnel over real jobs (analytics_real_jobs), straight from job_events. */
export async function loadFunnel(sql: Sql, opts: { since?: Date } = {}): Promise<Funnel> {
  const since = opts.since ?? new Date(0);
  const jobs = await sql<{ id: string; state: string }[]>`select id, state from public.analytics_real_jobs where created_at >= ${since} order by created_at`;
  if (!jobs.length) return buildFunnel([]);
  const events = await sql<{ job_id: string; type: string; data: Record<string, unknown> }[]>`select job_id, type, data from public.job_events where job_id in ${sql(jobs.map((j) => j.id))} order by job_id, seq`;
  const by = new Map<string, FunnelEvent[]>();
  for (const e of events) by.set(e.job_id, [...(by.get(e.job_id) ?? []), { type: e.type, data: e.data }]);
  return buildFunnel(jobs.map((j) => ({ id: j.id, state: j.state, events: by.get(j.id) ?? [] })));
}

/** Plain-text report (what the script prints). */
export function tractionText(t: { traction: Traction; excluded: Excluded }, f: Funnel): string {
  const lines = [
    "Haggle pilot traction (verified outcomes only; live jobs outside test workspaces/jobs, non-simulated businesses)",
    ...TRACTION_METRICS.map((k) => `  ${k.padEnd(34)} ${String(t.traction[k]).padStart(8)}  ${TRACTION_DEFINITIONS[k]}`),
    `Excluded: ${t.excluded.mock_jobs} mock jobs, ${t.excluded.live_jobs_marked_test} live jobs marked test (${t.excluded.test_workspaces} test workspaces, ${t.excluded.test_jobs} test jobs), ${t.excluded.simulated_vendors_in_real_jobs} simulated vendors in real jobs, ${t.excluded.simulated_or_test_payments} simulated/test-mode payments.`,
    "",
    `Abandonment funnel (${f.jobs} real jobs, from job_events)`,
    ...MILESTONES.map((m) => `  reached ${m.padEnd(20)} ${String(f.reached[m]).padStart(6)}`),
    ...(f.stopped.length ? ["Where jobs stopped (open now / ended cancelled or failed):", ...f.stopped.map((s) => `  ${s.reason}: ${s.open} open, ${s.ended} ended`)] : ["No stopped jobs."]),
  ];
  return lines.join("\n");
}
