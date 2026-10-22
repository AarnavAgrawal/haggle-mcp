// Background reliability policy (overnight sprint, workstream C): what may be re-attempted on its
// own, what must wait for an operator, and what an operator may re-arm. Pure; the engine and
// scripts/job-ops.ts both decide with these, so the two can never disagree.
//
// The rules, in order of how much harm a duplicate does:
//   * A Voice AI call takes no provider idempotency key: once it may have rung (claimed and never
//     answered, or an ambiguous provider error) it is never dialed again, by the engine or by an
//     operator. Only a definite "not placed" is retried.
//   * An obligation (accepting a quote, confirming a booking, telling a business it was paid, a
//     payment step) is never re-sent while its outcome is unknown; it goes to operator review.
//   * Anything else (an RFQ, a follow-up, a text) is re-sent under its own provider idempotency
//     key, a bounded number of times, then goes to operator review. Nothing retries forever.
import type { OperatorReviewRow, OutboxRow } from "../store/types.ts";
import { redactText } from "../live/log.ts";

/** Attempts of one outbox action before it goes to operator review (106 caps the column at 20). */
export const OUTBOX_MAX_ATTEMPTS = 5;
/** An obligation is re-attempted automatically at most this many times, and only after a definite failure. */
export const OBLIGATION_MAX_ATTEMPTS = 2;
/** A placed-but-unanswered Voice AI call that is retried after a definite "not placed" refusal. */
export const CALL_MAX_OUTBOX_ATTEMPTS = 3;
/**
 * A Stripe `charging` row older than this is never resumed automatically: Stripe forgets
 * idempotency keys after 24 h, so a resume past that could charge a second time if the first
 * charge went through and only its response was lost.
 */
export const CHARGE_RESUME_MAX_AGE_MS = 20 * 60 * 60_000;
/** Retryable Stripe failures (network, 5xx) resumed before the charge goes to operator review. */
export const CHARGE_MAX_RETRIES = 5;
/**
 * Inkbox replays the original response for the same idempotency key (and input) for 7 days. An
 * action first claimed longer ago than this is never re-sent under its key, by the engine or an
 * operator: if the first attempt went out and only its response was lost, the provider no longer
 * remembers it and a re-send would deliver it twice.
 */
export const PROVIDER_KEY_MAX_AGE_MS = 6 * 86_400_000;

/** Keys whose send accepts, confirms or pays: a duplicate can create an obligation (sendKeys, startHandoff, sendConfirmation). */
const OBLIGATION_KEY = /^(?:imsg:)?(?:accept|confirm|pay|handoff):/;
export const isObligationKey = (key: string) => OBLIGATION_KEY.test(key);

export type ClaimDecision =
  | { action: "send"; reclaim: boolean }
  | { action: "defer"; retryAfterMs: number; reason: string }
  | { action: "review"; reason: string }
  | { action: "refuse"; reason: string };

/**
 * An outbox key was already claimed (claimOutbox returned fresh: false). Decide whether this
 * attempt may call the provider. `send` with reclaim false = already sent: the caller resends under
 * the same provider key to get the provider's record back (email, text); never for an obligation.
 */
export function decideClaim(i: { kind: OutboxRow["kind"]; key: string; row: Pick<OutboxRow, "status" | "attempts" | "updated_at"> & { created_at?: string }; nowMs: number; staleMs: number; underReview: boolean }): ClaimDecision {
  const { row } = i;
  const stale = i.nowMs - Date.parse(row.updated_at) >= i.staleMs;
  if (i.underReview && row.status !== "sent") return { action: "refuse", reason: "this action is under operator review; it is not attempted again until an operator resolves it" };
  // Past the provider's idempotency window (a long outage, a job stuck for days): never re-sent under its key.
  if (i.kind !== "call" && row.status !== "sent" && row.created_at && i.nowMs - Date.parse(row.created_at) >= PROVIDER_KEY_MAX_AGE_MS) {
    return row.status === "pending" && !stale ? { action: "defer", retryAfterMs: i.staleMs, reason: "another instance is sending this right now" } : { action: "review", reason: "first attempted longer ago than the provider remembers its idempotency key; re-sending could deliver it twice" };
  }
  if (i.kind === "call") {
    if (row.status === "not_sent") return row.attempts >= CALL_MAX_OUTBOX_ATTEMPTS ? { action: "review", reason: `call not placed after ${row.attempts} attempts` } : { action: "send", reclaim: true };
    if (row.status === "sent") return { action: "refuse", reason: "this call was already placed" };
    if (row.status === "pending" && !stale) return { action: "refuse", reason: "another instance is placing this call right now; not dialed again" };
    return { action: "review", reason: row.status === "unknown" ? "call outcome unknown (the provider failed after dialing may have started); never redialed" : "call claimed but its result was never recorded (a crash after dialing may have started); never redialed" };
  }
  const obligation = isObligationKey(i.key);
  // Email and texts: re-sent under the same provider key to get the provider's record back (Inkbox
  // replays it). An A2A task's messageId dedupe is unverified, so a sent one is never sent again.
  if (row.status === "sent") return obligation || i.kind === "a2a" ? { action: "refuse", reason: "already sent" } : { action: "send", reclaim: false };
  if (row.status === "pending" && !stale) return { action: "defer", retryAfterMs: i.staleMs, reason: "another instance is sending this right now" };
  if (obligation && row.status !== "not_sent") return { action: "review", reason: "an acceptance, confirmation or payment step whose outcome is unknown; not re-sent automatically" };
  // An A2A task's messageId dedupes only if the business's agent honours it (unverified): an
  // outcome nobody knows (a crash mid-send, a failure after the request went out) is not re-sent.
  if (i.kind === "a2a" && row.status !== "not_sent") return { action: "review", reason: "A2A task outcome unknown (the business's agent may have received it); not re-sent automatically" };
  // Any channel: the provider said the request may have been acted on (e.g. an idempotency conflict).
  if (row.status === "unknown") return { action: "review", reason: `${i.kind} outcome unknown (the provider may have accepted it); not re-sent automatically` };
  const max = obligation ? OBLIGATION_MAX_ATTEMPTS : OUTBOX_MAX_ATTEMPTS;
  if (row.attempts >= max) return { action: "review", reason: `not sent after ${row.attempts} attempts` };
  return { action: "send", reclaim: true };
}

export type ChargeHold = { hold: false; released: boolean } | { hold: true; reason: string };

/**
 * May a Stripe `charging` row be resumed (same idempotency key) right now? `releasedAt`: an
 * operator released it (job-ops retry --payment); age and retries then count from the release,
 * and the caller must re-run the payment guard before charging.
 */
export function decideChargeResume(i: { createdAt: string; retries: number; nowMs: number; underReview: boolean; releasedAt: string | null }): ChargeHold {
  if (i.underReview) return { hold: true, reason: "this charge is under operator review" };
  const from = Math.max(Date.parse(i.createdAt), i.releasedAt ? Date.parse(i.releasedAt) : 0);
  if (i.nowMs - from >= CHARGE_RESUME_MAX_AGE_MS) return { hold: true, reason: "charge older than Stripe keeps idempotency keys; resuming could charge twice" };
  if (i.retries >= CHARGE_MAX_RETRIES) return { hold: true, reason: `charge still failing after ${i.retries} retries` };
  return { hold: false, released: i.releasedAt !== null };
}

/**
 * An error as it may be stored or logged: no addresses, phone numbers, keys, tokens, URLs' query
 * strings or long secrets-looking runs; one line, at most 300 characters.
 */
export function redactError(e: unknown): string {
  const raw = e instanceof Error ? `${e.name}: ${e.message}` : typeof e === "string" ? e : (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
  // The logger's patterns first (payment card, IBAN and account numbers among them), then these.
  return redactText(raw)
    .replace(/\b(?:sk|pk|rk|whsec|hgw|hgc)_[A-Za-z0-9_]+/g, "[key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s"']+/gi, (u) => u.replace(/\/\/[^@/\s]*@/, "//[redacted]@").replace(/\?.*$/, "?[redacted]"))
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[token]")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "[phone]")
    .replace(/\s+/g, " ").trim().slice(0, 300);
}

/** What an operator's `job-ops retry --key` may do with one outbox key. */
export type RetryTarget =
  | { kind: "first_contact"; jobId: string; businessId: string }
  | { kind: "obligation"; jobId: string | null }
  | { kind: "unsupported"; how: string };

/** First contacts are re-queued on their business (rfq/imsg-rfq/a2a/call keys); obligations re-run their step. */
export function retryTarget(key: string): RetryTarget {
  const first = key.match(/^(?:rfq|imsg-rfq|a2a|call):([^:]+):([^:]+)$/);
  if (first) return { kind: "first_contact", jobId: first[1]!, businessId: first[2]! };
  if (isObligationKey(key)) return /^(?:imsg:)?pay:/.test(key) ? { kind: "unsupported", how: "x402 payment steps (legacy rail) are never re-sent by an operator" } : { kind: "obligation", jobId: null };
  return { kind: "unsupported", how: "follow-ups, answers, counteroffers, messages and texts to the human aren't re-sent by key: the engine re-decides them, or send it again through its tool (send_message, answer_business)" };
}

export type RetryStep =
  | { op: "resolve_review"; id: string; resolution: string; by: string }
  | { op: "rearm_outbox"; key: string }
  | { op: "requeue_business"; jobId: string; businessId: string }
  | { op: "event"; jobId: string; type: "operator_retry" | "operator_release" | "operator_hold" | "operator_resume" | "operator_close_requested"; data: Record<string, unknown> }
  | { op: "open_review"; review: Pick<OperatorReviewRow, "job_id" | "kind" | "subject" | "reason"> };

export type RetryPlan = { ok: true; steps: RetryStep[]; note: string } | { ok: false; reason: string };

const OPEN_FOR_CONTACT = new Set(["contacting", "collecting", "negotiating"]);

/** What job-ops found about the business an outbox key contacts: a suppression, and whether its workspace still authorizes it (null: not applicable, e.g. the global roster). */
export interface ContactCheck { suppressed: "opt_out" | "bounce" | null; authorized: boolean | null }

/**
 * Plan an operator retry of one outbox action (pure; job-ops.ts applies the steps). Never for a
 * call that may have rung; an obligation only with `override` and only while its approval stands
 * (the engine re-checks the approval before re-sending it).
 */
export function planOutboxRetry(i: { key: string; row: OutboxRow | null; review: OperatorReviewRow | null; job: { id: string; state: string } | null; businessStatus?: string | null; override: boolean; by: string; contact?: ContactCheck; nowMs?: number }): RetryPlan {
  const { row } = i;
  if (!row) return { ok: false, reason: `no outbox action with key ${i.key}` };
  if (row.status === "sent") return { ok: false, reason: "it was already sent; nothing to retry" };
  if (row.kind === "call" && row.status !== "not_sent") return { ok: false, reason: "a call whose outcome is unknown (it may have rung) is never redialed, not even by an operator; check the Inkbox call log, then resolve the review" };
  // The same safeguards as the first send, checked before anything is re-armed (the engine checks them again).
  if (i.contact?.suppressed) return { ok: false, reason: `the business is suppressed (${i.contact.suppressed}) since this was claimed; it is never contacted again. If the suppression is wrong, remove it first (workspace-admin.ts remove-suppression), then retry` };
  if (i.contact?.authorized === false) return { ok: false, reason: "the business is no longer an authorized vendor of this workspace; re-authorize it (workspace-admin.ts add-vendor --consent ...) before retrying" };
  if (i.nowMs !== undefined && row.kind !== "call" && i.nowMs - Date.parse(row.created_at) >= PROVIDER_KEY_MAX_AGE_MS) return { ok: false, reason: "first attempted longer ago than the provider remembers its idempotency key (7 days): a re-send could deliver it twice. Check the Inkbox sent folder; if it never went out, contact the business in a new deal" };
  // A claim with no review is in flight (or the engine will settle it); one under review was left by a crash.
  if (row.status === "pending" && !i.review) return { ok: false, reason: "it is claimed right now (pending); wait for the engine to settle it" };
  const t = retryTarget(i.key);
  if (t.kind === "unsupported") return { ok: false, reason: t.how };
  if (!i.job) return { ok: false, reason: "its job no longer exists" };
  const resolve: RetryStep[] = i.review ? [{ op: "resolve_review", id: i.review.id, resolution: "operator retry", by: i.by }] : [];
  if (t.kind === "first_contact") {
    if (!OPEN_FOR_CONTACT.has(i.job.state)) return { ok: false, reason: `job is ${i.job.state}; a first contact is only re-sent while the deal is collecting` };
    if (i.businessStatus && !["pending", "bounced", "unavailable"].includes(i.businessStatus)) return { ok: false, reason: `the business is ${i.businessStatus}; it was reached, so its first contact isn't re-sent` };
    return { ok: true, steps: [...resolve, { op: "rearm_outbox", key: i.key }, { op: "requeue_business", jobId: t.jobId, businessId: t.businessId }], note: "re-queued: the engine's next advance sends it once, under the same provider key, through every normal check (suppression, authorization)" };
  }
  if (!i.override) return { ok: false, reason: "an acceptance or confirmation can create an obligation; re-send it only after checking it never arrived, with --override-obligation" };
  const confirm = /^(?:imsg:)?confirm:/.test(i.key);
  if (confirm ? !["paid", "confirmed"].includes(i.job.state) : i.job.state !== "paying") return { ok: false, reason: `job is ${i.job.state}; ${confirm ? "a confirmation is only re-sent once the deal is paid or confirmed" : "an acceptance is only re-sent while the deal is paying"}` };
  return { ok: true, steps: [...resolve, { op: "rearm_outbox", key: i.key }, { op: "event", jobId: i.job.id, type: "operator_retry", data: { key: i.key, by: i.by } }], note: "the engine re-sends it on its next advance, only if the approval it rests on still stands" };
}

/**
 * Release a held Stripe charge (job-ops retry --payment, with --override-financial). The engine
 * then re-runs the full payment guard (approval, quote, amount, payee, caps) before charging.
 */
export function planChargeRelease(i: { payment: { id: string; job_id: string; status: string } | null; review: OperatorReviewRow | null; override: boolean; by: string }): RetryPlan {
  if (!i.payment) return { ok: false, reason: "no such payment" };
  if (i.payment.status !== "charging") return { ok: false, reason: `payment is ${i.payment.status}; only a held charge can be released` };
  if (!i.review) return { ok: false, reason: "this charge isn't held for review" };
  if (!i.override) return { ok: false, reason: "releasing a charge can move money: first check the Stripe dashboard has no PaymentIntent for this approval (metadata approval_id), then pass --override-financial" };
  return { ok: true, steps: [{ op: "resolve_review", id: i.review.id, resolution: "charge released by the operator", by: i.by }, { op: "event", jobId: i.payment.job_id, type: "operator_release", data: { payment_id: i.payment.id, by: i.by } }], note: "the engine re-runs the payment guard before resuming the charge under the same idempotency key" };
}

// ───────────────────────────── job-level operator actions (job-ops review-job / resume / fail-safe-close) ─────────────────────────────

/** An operator hold is an open `stuck_job` review with this subject: while it is open the engine's background advance leaves the job alone. */
export const holdSubject = (jobId: string) => `hold:${jobId}`;
/** A requested fail-safe close is an open `stuck_job` review with this subject; the server resolves it once the job is closed. */
export const closeSubject = (jobId: string) => `close:${jobId}`;

const CLOSED = new Set(["paid", "confirmed", "cancelled", "failed"]);
/** Payment states where money may be moving: a deal is never closed under them. */
const MONEY_MOVING = new Set(["charging", "signed", "sent"]);

/** Put a job on hold (job-ops review-job): nothing more is sent for it by the background advance until `resume`. */
export function planJobHold(i: { job: { id: string; state: string } | null; hold: OperatorReviewRow | null; note: string; by: string }): RetryPlan {
  if (!i.job) return { ok: false, reason: "no such job" };
  if (CLOSED.has(i.job.state)) return { ok: false, reason: `job is ${i.job.state}; nothing runs for it, so there is nothing to hold` };
  if (i.hold) return { ok: false, reason: `job is already on hold (${i.hold.id}); resume it with job-ops resume` };
  return {
    ok: true,
    steps: [
      { op: "open_review", review: { job_id: i.job.id, kind: "stuck_job", subject: holdSubject(i.job.id), reason: `operator hold by ${i.by}: ${i.note}`.slice(0, 200) } },
      { op: "event", jobId: i.job.id, type: "operator_hold", data: { by: i.by, note: i.note } },
    ],
    note: "on hold: the server's background advance (sends, follow-ups, deadline closes, reading replies) skips this job until you resume it. Inbound replies are still stored, and a human's own text decision still applies",
  };
}

/** Lift a hold (job-ops resume): the next advance carries on from the job's current state, every send still keyed and checked. */
export function planResume(i: { job: { id: string; state: string } | null; hold: OperatorReviewRow | null; note: string; by: string }): RetryPlan {
  if (!i.job) return { ok: false, reason: "no such job" };
  if (!i.hold) return { ok: false, reason: "job isn't on hold" };
  return {
    ok: true,
    steps: [{ op: "resolve_review", id: i.hold.id, resolution: `resumed: ${i.note}`.slice(0, 500), by: i.by }, { op: "event", jobId: i.job.id, type: "operator_resume", data: { by: i.by, note: i.note } }],
    note: "resumed: the next advance picks the job up where it is. Nothing already sent is sent again",
  };
}

/**
 * Close a stuck job safely (job-ops fail-safe-close). The running server performs it on its next
 * advance (HaggleEngine.operatorClose): the job is marked failed (closed by the operator), a
 * pending approval expires, a booking or payment handoff not yet paid is withdrawn on Haggle's side,
 * and the human is texted exactly that. No business is contacted. Refused while money may be moving.
 */
export function planFailSafeClose(i: { job: { id: string; state: string } | null; payment: { status: string } | null; closeRequested: boolean; reason: string; by: string }): RetryPlan {
  if (!i.job) return { ok: false, reason: "no such job" };
  if (CLOSED.has(i.job.state)) return { ok: false, reason: `job is already ${i.job.state}; nothing to close` };
  if (i.payment && MONEY_MOVING.has(i.payment.status)) return { ok: false, reason: `a payment is in flight (${i.payment.status}); resolve it first (the Stripe dashboard, then job-ops retry --payment or resolve), then close` };
  if (i.closeRequested) return { ok: false, reason: "a close is already requested; the server performs it on its next advance (check with inspect)" };
  return {
    ok: true,
    steps: [
      { op: "open_review", review: { job_id: i.job.id, kind: "stuck_job", subject: closeSubject(i.job.id), reason: `fail-safe close requested by ${i.by}: ${i.reason}`.slice(0, 200) } },
      { op: "event", jobId: i.job.id, type: "operator_close_requested", data: { by: i.by, reason: i.reason } },
    ],
    note: "close requested: on its next advance the server marks the job failed (closed by the operator), expires any pending approval, withdraws an unpaid booking on Haggle's side and texts the human what happened. No business is contacted: tell any that are holding something for this deal yourself",
  };
}
