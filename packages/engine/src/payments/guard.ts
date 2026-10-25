// PURE: may this payment run? checkApprovedPayment: the approval-level rules every charge passes
// (payments/stripe.ts checkStripePaymentAllowed builds on it), plus the approval immutability rule.
// Rules run in order and the first failure wins. The amount is always the approval's
// payment_cents read from the database; nothing in tool input or email text can change it.
//
// Adapted from quote-broker@8a68559 src/payments/guard.ts (Partner; Stripe). Kept rules 1–7
// (approval exists for this job, idempotent repeat, approved and unexpired, exact quote/business/
// amount, spend cap, payable job state). The legacy x402 challenge rules were removed with the
// x402 rail.

/** Rules 1–7: the approval itself. */
export interface ApprovedPaymentInput {
  job: { id: string; state: string };
  approval: {
    id: string;
    job_id: string;
    quote_id: string;
    business_id: string;
    quote_total_cents: number;
    payment_cents: number;
    status: string;
    expires_at: string;
  } | null;
  quote: { id: string; business_id: string; total_cents: number | null; deposit_cents: number | null; status: string } | null;
  existingPayment: { id: string; status: string } | null;
  spendCapCents: number;
  now: Date;
}

export type ApprovedPaymentCode =
  | "APPROVAL_NOT_FOUND" | "PAYMENT_IN_FLIGHT" | "APPROVAL_PENDING" | "APPROVAL_DECLINED" | "APPROVAL_EXPIRED"
  | "QUOTE_CHANGED" | "AMOUNT_MISMATCH" | "OVER_SPEND_CAP" | "JOB_NOT_READY";

export type ApprovedPaymentResult =
  | { ok: true; existingPayment?: { id: string; status: string } }
  | { ok: false; code: ApprovedPaymentCode; existingPayment?: { id: string; status: string } };

/**
 * Rules 1–7 (quote-broker's Stripe guard): the approval exists for this job; a settled payment is
 * an idempotent success and an in-flight one is never repeated; the human approved and it is
 * unexpired; exactly the quote revision, business and amounts the human saw; under the spend cap;
 * the job is payable. The amount is always the approval's payment_cents.
 */
export function checkApprovedPayment(i: ApprovedPaymentInput, inFlight: Set<string>): ApprovedPaymentResult {
  const { approval, quote } = i;
  const deny = (code: ApprovedPaymentCode, existingPayment?: { id: string; status: string }): ApprovedPaymentResult =>
    existingPayment ? { ok: false, code, existingPayment } : { ok: false, code };
  // 1. The approval exists and belongs to this job.
  if (!approval || approval.job_id !== i.job.id) return deny("APPROVAL_NOT_FOUND");
  // 2. Already settled: idempotent success. In flight: never pay a second time.
  if (i.existingPayment?.status === "settled") return { ok: true, existingPayment: i.existingPayment };
  if (i.existingPayment && inFlight.has(i.existingPayment.status)) return deny("PAYMENT_IN_FLIGHT", i.existingPayment);
  // 3. The human approved it, and it hasn't been used.
  switch (approval.status) {
    case "approved":
      break;
    case "pending":
      return deny("APPROVAL_PENDING");
    case "declined":
      return deny("APPROVAL_DECLINED");
    default:
      return deny("APPROVAL_EXPIRED");
  }
  // 4. Still within its time limit.
  if (i.now.getTime() >= Date.parse(approval.expires_at)) return deny("APPROVAL_EXPIRED"); // expired AT expires_at
  // 5. Exactly the quote revision, business, and amounts the human saw.
  if (!quote || quote.id !== approval.quote_id || quote.business_id !== approval.business_id || quote.status !== "current") return deny("QUOTE_CHANGED");
  // The payment is the quote's deposit; a quote with no deposit is paid in full (exactly its total).
  const due = quote.deposit_cents && quote.deposit_cents > 0 ? quote.deposit_cents : quote.total_cents;
  if (quote.total_cents !== approval.quote_total_cents || due !== approval.payment_cents || approval.payment_cents <= 0) return deny("AMOUNT_MISMATCH");
  // 6. Under the hard spend cap.
  if (approval.payment_cents > i.spendCapCents) return deny("OVER_SPEND_CAP");
  // 7. The job is in a payable state.
  if (i.job.state !== "paying") return deny("JOB_NOT_READY");
  return { ok: true };
}

/** What an approval binds: never changed after it is written (migration 121 enforces the same in Postgres). */
const APPROVAL_TERMS = ["id", "job_id", "quote_id", "business_id", "quote_total_cents", "payment_cents", "cap_cents", "action", "created_at"] as const;
/** The only ways an approval's status moves up; anything may expire. A decided approval never becomes pending or approved again. */
const APPROVAL_STATUS_FROM: Record<string, readonly string[]> = { approved: ["pending"], declined: ["pending"], locked: ["pending"], used: ["approved"], pending: [] };

/** Why this update to a stored approval is refused (S5-D F14), or null when it only records a decision. */
export function approvalUpdateViolation(row: { status: string }, change: object): string | null {
  const old = row as Record<string, unknown> & { status: string }, patch = change as Record<string, unknown>;
  for (const k of APPROVAL_TERMS) if (patch[k] !== undefined && patch[k] !== old[k]) return `an approval's terms are immutable (${k})`;
  const to = patch.status;
  if (typeof to === "string" && to !== old.status && to !== "expired" && !(APPROVAL_STATUS_FROM[to] ?? []).includes(old.status)) return `approval status can't go from ${old.status} to ${to}`;
  return null;
}
