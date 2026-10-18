// PURE: the job state machine. No I/O, no clock reads: the caller passes `now` and the facts the
// guards need, and gets back the next state plus effects to run AFTER the change is committed.
//
// Adapted from quote-broker@8a68559 src/jobs/stateMachine.ts (Partner): same shape (transition ->
// next + effects, terminal states reject everything, closing a window either negotiates or
// finishes). Changes for Haggle v3: the contract's 9 JobStates; "ready" is a flag rather than a
// state; approval leads to `paying` (x402 invoice + payment) instead of a Stripe charge; a
// deadline with no eligible quote fails the job with a reason.
import type { JobState } from "../contract.ts";

export const TERMINAL: ReadonlySet<JobState> = new Set(["paid", "cancelled", "failed"]);

export type JobEvent =
  | { type: "rfqs_sent" }
  | { type: "window_closed" } // deadline passed or every contacted business answered
  | { type: "approval_requested" }
  | { type: "approval_verified" }
  | { type: "approval_void" } // declined, expired, or the quote was revised
  | { type: "payment_settled" }
  | { type: "payment_failed_final" }
  | { type: "cancelled" };

export interface MachineState {
  state: JobState;
  round: number;
  max_rounds: number;
  collect_until: string;
  ready: boolean;
  failure_reason: string | null;
}

export interface TransitionContext {
  now: Date;
  /** Quotes the ranker would accept right now (current, compliant, trusted, priced, in budget). */
  eligibleQuotes: number;
  /**
   * Quotes the human may still knowingly approve: eligible ones plus those held back only by the
   * budget or a requirement the business didn't confirm. Defaults to eligibleQuotes.
   */
  approvableQuotes?: number;
  /** Some business priced above the best eligible quote and has rounds left. */
  counterable: boolean;
  negotiationWindowMs: number;
  /** A payment is signed or sent and not yet resolved. */
  paymentInFlight: boolean;
}

export type Effect =
  | { type: "send_rfqs" }
  | { type: "send_counteroffers"; round: number }
  | { type: "send_accept" }
  | { type: "notify_cancelled" };

export type TransitionResult = { ok: true; next: MachineState; effects: Effect[] } | { ok: false; reason: string };

const to = (s: MachineState, patch: Partial<MachineState>, effects: Effect[] = []): TransitionResult => ({ ok: true, next: { ...s, ...patch }, effects });
const reject = (s: MachineState, e: JobEvent): TransitionResult => ({ ok: false, reason: `${e.type} is not allowed in state ${s.state}` });

/** Close a collection/negotiation window: negotiate another round, finish, or fail. */
function closeWindow(s: MachineState, ctx: TransitionContext): TransitionResult {
  // Fail only when nothing is approvable; over-budget or unconfirmed quotes go to the human.
  if ((ctx.approvableQuotes ?? ctx.eligibleQuotes) === 0) return to(s, { state: "failed", failure_reason: "no_eligible_quote" });
  // Negotiate while a truthful counter exists (a real cheaper quote, or the buyer's target) and rounds remain.
  if (ctx.eligibleQuotes >= 1 && ctx.counterable && s.round < s.max_rounds) {
    const round = s.round + 1;
    return to(s, { state: "negotiating", round, ready: false, collect_until: new Date(ctx.now.getTime() + ctx.negotiationWindowMs).toISOString() }, [
      { type: "send_counteroffers", round },
    ]);
  }
  return to(s, { ready: true });
}

export function transition(s: MachineState, e: JobEvent, ctx: TransitionContext): TransitionResult {
  if (TERMINAL.has(s.state)) return reject(s, e);

  if (e.type === "cancelled") {
    // Money in flight can't be cancelled; it resolves to settled or failed first.
    if (s.state === "paying" && ctx.paymentInFlight) return { ok: false, reason: "a payment is in flight; it can't be cancelled" };
    return to(s, { state: "cancelled" }, [{ type: "notify_cancelled" }]);
  }

  switch (s.state) {
    case "created":
      // RFQs go out as an effect of entering `contacting`.
      return reject(s, e);
    case "contacting":
      if (e.type === "rfqs_sent") return to(s, { state: "collecting" });
      return reject(s, e);
    case "collecting":
    case "negotiating":
      if (e.type === "window_closed") return s.ready ? to(s, {}) : closeWindow(s, ctx);
      if (e.type === "approval_requested") return (ctx.approvableQuotes ?? ctx.eligibleQuotes) > 0 ? to(s, { state: "awaiting_approval" }) : { ok: false, reason: "no eligible quote to approve" };
      return reject(s, e);
    case "awaiting_approval":
      if (e.type === "approval_verified") return to(s, { state: "paying" }, [{ type: "send_accept" }]);
      if (e.type === "approval_void") return to(s, { state: s.round > 1 ? "negotiating" : "collecting", ready: true });
      return reject(s, e);
    case "paying":
      if (e.type === "payment_settled") return to(s, { state: "paid" });
      // The approved quote changed (or the approval lapsed) before any money moved: back to choosing.
      if (e.type === "approval_void") return ctx.paymentInFlight ? { ok: false, reason: "a payment is in flight" } : to(s, { state: s.round > 1 ? "negotiating" : "collecting", ready: true });
      if (e.type === "payment_failed_final") return to(s, { state: "failed", failure_reason: "payment_failed" });
      return reject(s, e);
  }
  return reject(s, e);
}

/** Start a job: created -> contacting with the RFQ effect. */
export function start(s: MachineState): TransitionResult {
  if (s.state !== "created") return { ok: false, reason: `start is not allowed in state ${s.state}` };
  return to(s, { state: "contacting" }, [{ type: "send_rfqs" }]);
}
