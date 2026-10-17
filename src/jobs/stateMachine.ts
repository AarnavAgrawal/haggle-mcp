// PURE: the job state machine (DESIGN.md §7). No I/O, no clock reads: the
// caller passes `now` and the facts the guards need, and gets back the next
// state plus a list of effects to run AFTER the state change is committed.
//
// PAIR-WRITTEN FILE (§25): review line by line. A bug here sends duplicate
// emails or lets a job reach a payable state it shouldn't.

export type JobStatus =
  | "collecting"
  | "negotiating"
  | "ready"
  | "awaiting_approval"
  | "approved"
  | "paid"
  | "expired"
  | "cancelled"
  | "payment_failed";

export const TERMINAL: ReadonlySet<JobStatus> = new Set(["paid", "expired", "cancelled"]);

export type JobEvent =
  | { type: "quote_parsed" }
  | { type: "all_vendors_replied" }
  | { type: "deadline_passed" }
  | { type: "approval_requested" }
  | { type: "approval_verified" }
  | { type: "approval_declined" }
  | { type: "approval_expired" }
  | { type: "payment_succeeded" }
  | { type: "payment_failed" }
  | { type: "cancelled" };

/** The slice of a job row the machine reads and writes. */
export interface JobState {
  status: JobStatus;
  round: number;
  max_rounds: number;
  collect_until: string | null; // ISO timestamp
}

export interface TransitionContext {
  now: Date;
  /** Current, available quotes on the job (guards for negotiation/expiry). */
  availableQuotes: number;
  negotiationWindowSeconds: number;
}

export type Effect = { type: "send_counteroffers"; round: number } | { type: "notify_cancelled" };

export type TransitionResult =
  | { ok: true; next: JobState; effects: Effect[] }
  | { ok: false; reason: string };

const stay = (job: JobState): TransitionResult => ({ ok: true, next: { ...job }, effects: [] });
const to = (job: JobState, status: JobStatus, effects: Effect[] = []): TransitionResult => ({
  ok: true,
  next: { ...job, status },
  effects,
});
const reject = (job: JobState, event: JobEvent): TransitionResult => ({
  ok: false,
  reason: `${event.type} is not allowed in status ${job.status}`,
});

/**
 * A collection or negotiation window closed (deadline, or everyone answered).
 *   no usable quotes          -> expired
 *   >= 2 quotes, rounds left  -> negotiating (next round), send counteroffers
 *   otherwise                 -> ready
 */
function closeWindow(job: JobState, ctx: TransitionContext): TransitionResult {
  if (ctx.availableQuotes === 0) return to(job, "expired");
  if (ctx.availableQuotes >= 2 && job.round < job.max_rounds) {
    const round = job.round + 1;
    const collectUntil = new Date(ctx.now.getTime() + ctx.negotiationWindowSeconds * 1000).toISOString();
    return {
      ok: true,
      next: { ...job, status: "negotiating", round, collect_until: collectUntil },
      effects: [{ type: "send_counteroffers", round }],
    };
  }
  return to(job, "ready");
}

export function transition(job: JobState, event: JobEvent, ctx: TransitionContext): TransitionResult {
  if (TERMINAL.has(job.status)) return reject(job, event);

  if (event.type === "cancelled") return to(job, "cancelled", [{ type: "notify_cancelled" }]);

  switch (job.status) {
    case "collecting":
    case "negotiating":
      if (event.type === "quote_parsed") return stay(job);
      if (event.type === "deadline_passed" || event.type === "all_vendors_replied") return closeWindow(job, ctx);
      return reject(job, event);

    case "ready":
      if (event.type === "approval_requested") return to(job, "awaiting_approval");
      return reject(job, event);

    case "awaiting_approval":
      if (event.type === "approval_verified") return to(job, "approved");
      if (event.type === "approval_declined" || event.type === "approval_expired") return to(job, "ready");
      return reject(job, event);

    case "approved":
      if (event.type === "payment_succeeded") return to(job, "paid");
      if (event.type === "payment_failed") return to(job, "payment_failed");
      return reject(job, event);

    case "payment_failed":
      if (event.type === "payment_succeeded") return to(job, "paid");
      if (event.type === "payment_failed") return stay(job);
      return reject(job, event);
  }
  return reject(job, event);
}
