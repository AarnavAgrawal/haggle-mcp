// Stalled-job detection: a read-only report over the repository, for operators (logs, alerts,
// /ready). It never changes a job: recovery is the engine's (advanceJob / the recovery paths); this
// only says which jobs have gone quiet for longer than they should, and why.
import type { JobRow, Repository } from "../store/types.ts";

export interface StallThresholds {
  /** A job still `created` (nothing sent) this long after its last change. */
  createdMs: number;
  /** Still `contacting` (sends in flight) this long. */
  contactingMs: number;
  /** `collecting` / `negotiating`: this long past its reply-by deadline with no change. */
  pastDeadlineMs: number;
  /** `paying` this long (a charge or handoff should settle or fail). */
  payingMs: number;
  /** An inbound reply still unparsed this long. */
  pendingMessageMs: number;
}

export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  createdMs: 10 * 60_000,
  contactingMs: 20 * 60_000,
  pastDeadlineMs: 30 * 60_000,
  payingMs: 30 * 60_000,
  pendingMessageMs: 15 * 60_000,
};

export type StallReason = "stuck_created" | "stuck_contacting" | "past_deadline" | "stuck_paying" | "unparsed_reply";
export interface StalledJob { job_id: string; workspace_id: string; state: JobRow["state"]; reason: StallReason; age_s: number }

type ReadRepo = Pick<Repository, "listOpenJobs" | "getPendingMessages">;

/** Every open job that looks stuck now, oldest first. Read-only. */
export async function findStalledJobs(repo: ReadRepo, now: Date = new Date(), t: StallThresholds = DEFAULT_STALL_THRESHOLDS): Promise<StalledJob[]> {
  const out: StalledJob[] = [];
  const at = now.getTime();
  for (const j of await repo.listOpenJobs()) {
    const idle = at - Date.parse(j.updated_at);
    const age_s = Math.round(idle / 1000);
    const hit = (reason: StallReason, age = age_s) => out.push({ job_id: j.id, workspace_id: j.workspace_id, state: j.state, reason, age_s: age });
    if (j.state === "created" && idle > t.createdMs) hit("stuck_created");
    else if (j.state === "contacting" && idle > t.contactingMs) hit("stuck_contacting");
    else if ((j.state === "collecting" || j.state === "negotiating") && at - Date.parse(j.collect_until) > t.pastDeadlineMs && idle > t.pastDeadlineMs) hit("past_deadline", Math.round((at - Date.parse(j.collect_until)) / 1000));
    else if (j.state === "paying" && idle > t.payingMs) hit("stuck_paying");
    if (j.state === "created") continue;
    const pending = await repo.getPendingMessages(j.id);
    const oldest = pending.reduce<number | null>((m, p) => { const c = Date.parse(p.created_at); return m === null || c < m ? c : m; }, null);
    if (oldest !== null && at - oldest > t.pendingMessageMs) hit("unparsed_reply", Math.round((at - oldest) / 1000));
  }
  return out.sort((a, b) => b.age_s - a.age_s);
}

/**
 * Periodic check: logs each newly stalled job+reason once, and alerts (deduped by the alerter).
 * A job that recovers and stalls again is reported again.
 */
export interface StalledMonitorOptions {
  repo: ReadRepo;
  thresholds?: StallThresholds;
  now?: () => Date;
  log?: (event: string, data: Record<string, unknown>) => void;
  alert?: (a: { key: string; severity: "warn" | "critical"; summary: string; details: Record<string, string | number | boolean | null> }) => Promise<unknown>;
}

export class StalledJobMonitor {
  private known = new Set<string>();
  private last: { at: string; count: number; jobs: StalledJob[] } | null = null;
  private readonly opts: StalledMonitorOptions;

  constructor(opts: StalledMonitorOptions) {
    this.opts = opts;
  }

  async check(): Promise<StalledJob[]> {
    const now = this.opts.now?.() ?? new Date();
    const jobs = await findStalledJobs(this.opts.repo, now, this.opts.thresholds ?? DEFAULT_STALL_THRESHOLDS);
    const keys = new Set(jobs.map((j) => `${j.job_id}:${j.reason}`));
    for (const j of jobs) {
      const key = `${j.job_id}:${j.reason}`;
      if (this.known.has(key)) continue;
      this.opts.log?.("job_stalled", { ...j });
      await this.opts.alert?.({ key: `stalled:${key}`, severity: j.reason === "stuck_paying" ? "critical" : "warn", summary: `Job ${j.job_id} looks stalled (${j.reason}, ${Math.round(j.age_s / 60)} min)`, details: { job_id: j.job_id, workspace_id: j.workspace_id, state: j.state, reason: j.reason, age_s: j.age_s } }).catch(() => {});
    }
    this.known = keys;
    this.last = { at: now.toISOString(), count: jobs.length, jobs };
    return jobs;
  }

  /** The last check's result (counts only for public surfaces). */
  lastReport() { return this.last; }
}
