import { z } from "zod";

/**
 * Job lifecycle. `clarifying` / `negotiating` describe the job as a whole —
 * individual sellers progress independently (see SellerConversationState).
 */
export const JobState = z.enum([
  "created",
  "dispatching",
  "collecting_quotes",
  "clarifying",
  "negotiating",
  "comparing",
  "awaiting_approval",
  "approved",
  "rejected",
  "payment_pending",
  "payment_failed",
  "settled",
  "cancelled",
  "expired",
  "failed",
]);
export type JobState = z.infer<typeof JobState>;

const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  created: ["dispatching", "cancelled", "failed"],
  dispatching: ["collecting_quotes", "cancelled", "failed"],
  collecting_quotes: ["clarifying", "negotiating", "comparing", "cancelled", "expired", "failed"],
  clarifying: ["collecting_quotes", "negotiating", "comparing", "cancelled", "expired", "failed"],
  negotiating: ["collecting_quotes", "clarifying", "comparing", "cancelled", "expired", "failed"],
  // A late quote or a seller question can reopen collection after comparing.
  comparing: ["collecting_quotes", "clarifying", "negotiating", "awaiting_approval", "cancelled", "expired"],
  // A quote revision while awaiting approval sends the job back to comparing (approval invalidated).
  awaiting_approval: ["approved", "rejected", "comparing", "cancelled", "expired"],
  rejected: ["comparing", "awaiting_approval", "cancelled", "expired"],
  approved: ["payment_pending", "comparing", "cancelled", "expired"],
  // An in-flight payment cannot be cancelled; it must resolve to settled or payment_failed first.
  payment_pending: ["settled", "payment_failed"],
  payment_failed: ["payment_pending", "comparing", "cancelled"],
  settled: [],
  cancelled: [],
  expired: [],
  failed: [],
};

export const TERMINAL_JOB_STATES: ReadonlySet<JobState> = new Set(["settled", "cancelled", "expired", "failed"]);

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export function assertJobTransition(from: JobState, to: JobState): void {
  if (!canTransitionJob(from, to)) {
    throw new InvalidTransitionError("job", from, to, JOB_TRANSITIONS[from]);
  }
}

export function allowedJobTransitions(from: JobState): readonly JobState[] {
  return JOB_TRANSITIONS[from];
}

/** Per-seller progress, shown as the seller pipeline on the deal board. */
export const SellerConversationState = z.enum([
  "pending", // known seller, RFQ not yet sent
  "contacted", // RFQ sent
  "replied", // at least one inbound message, no usable quote yet
  "clarifying", // Haggle asked a follow-up, or the seller asked a question
  "negotiating", // counteroffer round open
  "quoted", // has a current, usable quote
  "declined", // seller declined to quote
  "unresponsive", // no reply before the job's reply_by deadline
  "won",
  "lost",
  "withdrawn", // Haggle withdrew (job cancelled)
  "blocked", // flagged as unsafe (e.g. payment-link scam); never paid
]);
export type SellerConversationState = z.infer<typeof SellerConversationState>;

const SELLER_TRANSITIONS: Record<SellerConversationState, readonly SellerConversationState[]> = {
  pending: ["contacted", "withdrawn", "blocked"],
  contacted: ["replied", "clarifying", "quoted", "declined", "unresponsive", "withdrawn", "blocked"],
  replied: ["clarifying", "quoted", "declined", "unresponsive", "withdrawn", "blocked"],
  clarifying: ["replied", "quoted", "declined", "unresponsive", "withdrawn", "blocked"],
  negotiating: ["quoted", "clarifying", "declined", "unresponsive", "withdrawn", "blocked"],
  quoted: ["clarifying", "negotiating", "quoted", "won", "lost", "declined", "withdrawn", "blocked"],
  declined: ["replied", "quoted", "withdrawn"],
  // A late reply revives an unresponsive seller.
  unresponsive: ["replied", "quoted", "clarifying", "withdrawn", "blocked"],
  won: ["lost", "withdrawn"], // approval revoked / deal fell through
  lost: ["won"], // runner-up promoted after the winner failed
  withdrawn: [],
  blocked: [],
};

export function canTransitionSeller(from: SellerConversationState, to: SellerConversationState): boolean {
  return SELLER_TRANSITIONS[from].includes(to);
}

export function assertSellerTransition(from: SellerConversationState, to: SellerConversationState): void {
  if (!canTransitionSeller(from, to)) {
    throw new InvalidTransitionError("seller_conversation", from, to, SELLER_TRANSITIONS[from]);
  }
}

export class InvalidTransitionError extends Error {
  override name = "InvalidTransitionError";
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
    readonly allowed: readonly string[],
  ) {
    super(`Invalid ${entity} transition ${from} -> ${to}; allowed from ${from}: [${allowed.join(", ") || "none (terminal)"}]`);
  }
}
