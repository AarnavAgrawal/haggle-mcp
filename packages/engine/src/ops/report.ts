// The operator report (apps/mcp/scripts/ops-report.ts): everything that waits on a person, per
// workspace. Read-only by construction: it takes only the repository's read methods. Built from the
// same planners the server acts with (workflow/recovery.ts, ops/stalled.ts), so the report and the
// server never disagree about what is stuck.
import type { JobRow, OperatorReviewRow, Repository } from "../store/types.ts";
import { planRecovery, type StuckFinding } from "../workflow/recovery.ts";
import { findStalledJobs, type StalledJob } from "./stalled.ts";

export type ReportRepo = Pick<Repository,
  "listOpenJobs" | "listRecentJobs" | "listReviews" | "getLatestApproval" | "getBusinesses" | "listOutbox" | "listMessages" | "getPendingMessages"
  | "getPaymentForJob" | "getBookingByApproval" | "getHandoffByApproval">;

export interface OpsReportWorkspace {
  workspace_id: string;
  open_jobs: number;
  pending_approvals: { job_id: string; short_code: string; approval_id: string; channel: string; expires_at: string; expired: boolean }[];
  reviews: { id: string; kind: OperatorReviewRow["kind"]; job_id: string | null; subject: string; reason: string; attempts: number; age_h: number }[];
  failed_communications: { job_id: string; what: string; status: string; attempts: number | null }[];
  quarantined_replies: number;
  stalled_jobs: (Pick<StalledJob, "job_id" | "state" | "reason"> & { age_h: number })[];
  recovery: Pick<StuckFinding, "job_id" | "issue" | "action" | "detail" | "subject">[];
  handoffs_awaiting: { job_id: string; approval_id: string; business: string; stage: string; since: string; stalled: boolean }[];
}

export interface OpsReport {
  generated_at: string;
  /** Closed jobs are included this long after their last change (late replies, unsent confirmations). */
  closed_window_days: number;
  totals: { workspaces: number; open_jobs: number; pending_approvals: number; open_reviews: number; failed_communications: number; quarantined_replies: number; stalled_jobs: number; handoffs_awaiting: number };
  workspaces: OpsReportWorkspace[];
}

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;

export async function buildOpsReport(repo: ReportRepo, opts: { now?: Date; workspaceId?: string; closedWindowDays?: number; maxJobs?: number } = {}): Promise<OpsReport> {
  const now = opts.now ?? new Date();
  const at = now.getTime();
  const days = opts.closedWindowDays ?? 7;
  const open = await repo.listOpenJobs();
  const closed = (await repo.listRecentJobs(opts.maxJobs ?? 500)).filter((j) => TERMINAL.has(j.state) && at - Date.parse(j.updated_at) < days * 86_400_000);
  const jobs = [...open, ...closed.filter((c) => !open.some((o) => o.id === c.id))].filter((j) => !opts.workspaceId || j.workspace_id === opts.workspaceId).slice(0, opts.maxJobs ?? 500);
  const byWs = new Map<string, OpsReportWorkspace>();
  const ws = (id: string) => {
    let w = byWs.get(id);
    if (!w) byWs.set(id, (w = { workspace_id: id, open_jobs: 0, pending_approvals: [], reviews: [], failed_communications: [], quarantined_replies: 0, stalled_jobs: [], recovery: [], handoffs_awaiting: [] }));
    return w;
  };
  const jobWs = new Map<string, string>(jobs.map((j) => [j.id, j.workspace_id]));
  for (const s of await findStalledJobs(repo, now)) {
    if (jobWs.has(s.job_id)) ws(s.workspace_id).stalled_jobs.push({ job_id: s.job_id, state: s.state, reason: s.reason, age_h: hours(s.age_s * 1000) });
  }
  for (const job of jobs) await addJob(repo, ws(job.workspace_id), job, at);
  // Open reviews: by their job's workspace; a review with no job (a reconciler give-up) under "unscoped".
  for (const r of await repo.listReviews({ status: "open", limit: 1000 })) {
    const w = r.job_id ? jobWs.get(r.job_id) : undefined;
    if (opts.workspaceId && w !== opts.workspaceId) continue;
    ws(w ?? (r.job_id ? "unknown_job" : "unscoped")).reviews.push({ id: r.id, kind: r.kind, job_id: r.job_id, subject: r.subject, reason: r.reason, attempts: r.attempts, age_h: hours(at - Date.parse(r.created_at)) });
  }
  const workspaces = [...byWs.values()].sort((a, b) => a.workspace_id.localeCompare(b.workspace_id));
  const sum = (f: (w: OpsReportWorkspace) => number) => workspaces.reduce((n, w) => n + f(w), 0);
  return {
    generated_at: now.toISOString(),
    closed_window_days: days,
    totals: {
      workspaces: workspaces.length, open_jobs: sum((w) => w.open_jobs), pending_approvals: sum((w) => w.pending_approvals.length), open_reviews: sum((w) => w.reviews.length),
      failed_communications: sum((w) => w.failed_communications.length), quarantined_replies: sum((w) => w.quarantined_replies), stalled_jobs: sum((w) => w.stalled_jobs.length), handoffs_awaiting: sum((w) => w.handoffs_awaiting.length),
    },
    workspaces,
  };
}

async function addJob(repo: ReportRepo, w: OpsReportWorkspace, job: JobRow, at: number) {
  const [approval, businesses, outbox, messages, pending, payment] = await Promise.all([
    repo.getLatestApproval(job.id), repo.getBusinesses(job.id), repo.listOutbox({ jobId: job.id }), repo.listMessages(job.id), repo.getPendingMessages(job.id), repo.getPaymentForJob(job.id),
  ]);
  if (!TERMINAL.has(job.state)) w.open_jobs++;
  if (approval?.status === "pending" && !TERMINAL.has(job.state)) w.pending_approvals.push({ job_id: job.id, short_code: job.short_code, approval_id: approval.id, channel: approval.channel, expires_at: approval.expires_at, expired: Date.parse(approval.expires_at) < at });
  for (const o of outbox) if (o.status === "not_sent" || o.status === "unknown") w.failed_communications.push({ job_id: job.id, what: `${o.kind} ${o.key}`, status: o.status, attempts: o.attempts });
  for (const b of businesses) if (b.status === "bounced") w.failed_communications.push({ job_id: job.id, what: `${b.channel} to ${b.name}`, status: "bounced", attempts: b.send_attempts });
  w.quarantined_replies += messages.filter((m) => m.direction === "in" && m.quarantine_reason).length;
  const [booking, handoff] = approval ? await Promise.all([repo.getBookingByApproval(approval.id), repo.getHandoffByApproval(approval.id)]) : [null, null];
  const name = approval ? businesses.find((b) => b.business_id === approval.business_id)?.name ?? approval.business_id : "";
  if (approval && booking?.status === "awaiting_vendor_confirmation") w.handoffs_awaiting.push({ job_id: job.id, approval_id: approval.id, business: name, stage: "awaiting_vendor_confirmation", since: booking.created_at, stalled: !!booking.stalled_at });
  if (approval && handoff && (handoff.status === "instructions_requested" || handoff.status === "instructions_received")) {
    w.handoffs_awaiting.push({ job_id: job.id, approval_id: approval.id, business: name, stage: handoff.status === "instructions_requested" ? "awaiting_payment_instructions" : "awaiting_customer_payment", since: handoff.updated_at, stalled: !!handoff.stalled_at });
  }
  const findings = planRecovery({ job, businesses, approval, payment, outbox, pendingMessages: pending.length, booking, handoff }, at);
  for (const f of findings) w.recovery.push({ job_id: f.job_id, issue: f.issue, action: f.action, detail: f.detail, ...(f.subject ? { subject: f.subject } : {}) });
}

/** Plain text for a terminal: one section per workspace, only what needs a person. */
export function formatOpsReport(r: OpsReport): string {
  const t = r.totals;
  const lines = [
    `Haggle ops report ${r.generated_at} (closed jobs: last ${r.closed_window_days} days)`,
    `${t.workspaces} workspace(s) · ${t.open_jobs} open job(s) · ${t.pending_approvals} pending approval(s) · ${t.open_reviews} open review(s) · ${t.failed_communications} failed/bounced communication(s) · ${t.quarantined_replies} quarantined repl(ies) · ${t.stalled_jobs} stalled job(s) · ${t.handoffs_awaiting} handoff(s) awaiting action`,
  ];
  for (const w of r.workspaces) {
    lines.push("", `== ${w.workspace_id} (${w.open_jobs} open)`);
    const section = <T>(title: string, xs: T[], f: (x: T) => string) => { if (xs.length) lines.push(`  ${title}:`, ...xs.map((x) => `    ${f(x)}`)); };
    section("Pending approvals", w.pending_approvals, (a) => `${a.job_id} HG-${a.short_code} ${a.approval_id} via ${a.channel}${a.expired ? " (EXPIRED, still waiting)" : ` expires ${a.expires_at}`}`);
    section("Operator reviews", w.reviews, (v) => `${v.id} ${v.kind} [${v.subject}] ${v.age_h}h · ${v.reason}${v.attempts ? ` · attempts ${v.attempts}` : ""}`);
    section("Failed / bounced communications", w.failed_communications, (c) => `${c.job_id} ${c.what} · ${c.status}${c.attempts !== null ? ` · attempts ${c.attempts}` : ""}`);
    if (w.quarantined_replies) lines.push(`  Quarantined replies: ${w.quarantined_replies} (review with quarantine.ts)`);
    section("Stalled jobs", w.stalled_jobs, (s) => `${s.job_id} ${s.state} ${s.reason} · ${s.age_h}h`);
    section("Recovery findings", w.recovery, (f) => `${f.job_id} ${f.issue} → ${f.action}${f.subject ? ` [${f.subject}]` : ""} · ${f.detail}`);
    section("Handoffs awaiting action", w.handoffs_awaiting, (h) => `${h.job_id} ${h.business} · ${h.stage} since ${h.since}${h.stalled ? " (STALLED)" : ""}`);
  }
  if (!r.workspaces.length) lines.push("", "Nothing open or recently closed.");
  return lines.join("\n");
}
