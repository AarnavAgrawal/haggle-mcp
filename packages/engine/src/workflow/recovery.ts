// Stuck-job detection (overnight sprint, workstream C). Pure: given one job's rows and the time,
// say what is overdue and whether an advance can move it on safely or a person must look. The
// engine's backup tick acts on it (HaggleEngine.recoverStuck); scripts/job-ops.ts list-stuck only
// prints it. An advance is always safe to try (every send is keyed, every state change a CAS);
// what it can't fix within REVIEW_AFTER_MS goes to operator review instead of waiting forever.
import type { ApprovalRow, JobBusinessRow, JobRow, OutboxRow, PaymentRow } from "../store/types.ts";
import { isObligationKey, OUTBOX_MAX_ATTEMPTS } from "./deadLetter.ts";

export type StuckIssue =
  | "created_stalled" | "contacting_unsent" | "collection_overdue" | "approval_overdue" | "charge_stale"
  | "outbox_stale" | "call_claim_stale" | "outbox_unknown" | "outbox_exhausted" | "confirmation_not_sent" | "late_reply";

export interface StuckFinding {
  job_id: string;
  issue: StuckIssue;
  /** advance: the next advance should move it; review: a person must look; mark_unknown: a stale call claim is recorded as unknown (never redialed), then reviewed. */
  action: "advance" | "review" | "mark_unknown";
  detail: string;
  /** The outbox key or payment id it is about, when not the job itself. */
  subject?: string;
  overdue_ms: number;
}

export interface RecoverySnapshot {
  job: Pick<JobRow, "id" | "state" | "ready" | "collect_until" | "created_at" | "updated_at">;
  businesses: Pick<JobBusinessRow, "business_id" | "name" | "status" | "next_attempt_at">[];
  approval: Pick<ApprovalRow, "id" | "status" | "expires_at" | "action"> | null;
  payment: Pick<PaymentRow, "id" | "status" | "created_at" | "updated_at" | "rail"> | null;
  outbox: OutboxRow[];
  /** Inbound messages stored but not read (parse_status pending). */
  pendingMessages: number;
}

export const RECOVERY = {
  /** A job sits this long before an advance counts as overdue (matches the engine's STUCK_AFTER_MS). */
  stuckAfterMs: 2 * 60_000,
  /** Past collect_until: covers the counteroffer-loss (4 min) and on-call (4 min) graces. */
  windowGraceMs: 5 * 60_000,
  /** Overdue this long after an advance should have fixed it: operator review. */
  reviewAfterMs: 30 * 60_000,
  /** A pending outbox claim older than this is a crash between claim and result (OUTBOX_STALE_MS). */
  outboxStaleMs: 2 * 60_000,
  /** A paid or confirmed job whose confirmation hasn't gone out this long after it closed. */
  confirmationGraceMs: 10 * 60_000,
  /** A charging row untouched this long is resumed by an advance (the engine re-runs the guard). */
  chargeStaleMs: 10 * 60_000,
};

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);

export function planRecovery(s: RecoverySnapshot, nowMs: number, p = RECOVERY): StuckFinding[] {
  const out: StuckFinding[] = [];
  const { job } = s;
  const since = (iso: string) => nowMs - Date.parse(iso);
  const overdue = (issue: StuckIssue, late: number, detail: string, subject?: string) => {
    if (late < 0) return;
    out.push({ job_id: job.id, issue, action: late >= p.reviewAfterMs ? "review" : "advance", detail, overdue_ms: late, ...(subject ? { subject } : {}) });
  };
  if (job.state === "created") overdue("created_stalled", since(job.created_at) - p.stuckAfterMs, "never started (a crash before its first contacts)");
  if (job.state === "contacting") {
    const unsent = s.businesses.filter((b) => b.status === "pending" && (!b.next_attempt_at || Date.parse(b.next_attempt_at) <= nowMs));
    if (unsent.length) overdue("contacting_unsent", since(job.updated_at) - p.stuckAfterMs, `${unsent.length} first contact${unsent.length === 1 ? "" : "s"} never sent: ${unsent.map((b) => b.name).join(", ")}`);
  }
  if ((job.state === "collecting" || job.state === "negotiating") && !job.ready) overdue("collection_overdue", since(job.collect_until) - p.windowGraceMs, `${job.state} past its reply-by time and never closed`);
  if (job.state === "awaiting_approval" && s.approval?.status === "pending") overdue("approval_overdue", since(s.approval.expires_at) - 60_000, "the approval expired but the job still waits on it");
  if (job.state === "paying" && s.payment?.status === "charging" && s.payment.rail === "stripe") {
    const late = since(s.payment.updated_at) - p.chargeStaleMs;
    // The engine itself holds (and reviews) a charge too old to resume; here it is only nudged.
    if (late >= 0) out.push({ job_id: job.id, issue: "charge_stale", action: "advance", detail: "a charge left in flight (a crash or a retryable failure); the next advance re-runs the payment guard before resuming it", subject: s.payment.id, overdue_ms: late });
  }
  for (const o of s.outbox) {
    if (o.status === "pending" && since(o.updated_at) >= p.outboxStaleMs) {
      const late = since(o.updated_at) - p.outboxStaleMs;
      if (o.kind === "call") out.push({ job_id: job.id, issue: "call_claim_stale", action: "mark_unknown", detail: "a call was claimed but its result never recorded (it may have rung); recorded as unknown, never redialed", subject: o.key, overdue_ms: late });
      else if (isObligationKey(o.key)) out.push({ job_id: job.id, issue: "outbox_stale", action: "review", detail: "an acceptance, confirmation or payment step claimed but never recorded; not re-sent automatically", subject: o.key, overdue_ms: late });
      else if (!TERMINAL.has(job.state)) overdue("outbox_stale", late, `${o.kind} claimed but never recorded (a crash mid-send); its next attempt re-sends it under the same provider key`, o.key);
    } else if (o.status === "unknown") {
      out.push({ job_id: job.id, issue: "outbox_unknown", action: "review", detail: `${o.kind} outcome unknown; never re-attempted automatically`, subject: o.key, overdue_ms: since(o.updated_at) });
    } else if (o.status === "not_sent" && o.attempts >= OUTBOX_MAX_ATTEMPTS) {
      out.push({ job_id: job.id, issue: "outbox_exhausted", action: "review", detail: `${o.kind} not sent after ${o.attempts} attempts`, subject: o.key, overdue_ms: since(o.updated_at) });
    }
  }
  if ((job.state === "paid" || job.state === "confirmed") && s.approval) {
    const key = `confirm:${s.approval.id}`;
    const sent = s.outbox.some((o) => o.key === key && o.status === "sent");
    const late = since(job.updated_at) - p.confirmationGraceMs;
    if (!sent && late >= 0 && !s.outbox.some((o) => o.key === key && o.status === "pending")) {
      out.push({ job_id: job.id, issue: "confirmation_not_sent", action: "review", detail: "the deal closed but the business was never told to go ahead (its confirmation failed); not re-sent automatically", subject: key, overdue_ms: late });
    }
  }
  if (TERMINAL.has(job.state) && s.pendingMessages > 0) out.push({ job_id: job.id, issue: "late_reply", action: "advance", detail: `${s.pendingMessages} repl${s.pendingMessages === 1 ? "y" : "ies"} arrived after the deal closed`, overdue_ms: 0 });
  return out;
}
