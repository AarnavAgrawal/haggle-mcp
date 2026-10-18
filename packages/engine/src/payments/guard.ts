// PURE: may this payment run? checkApprovedPayment (both rails) + checkX402PaymentAllowed (x402).
// May this x402 payment be signed? The last line of defense before money moves.
// Rules run in order and the first failure wins. The amount is always the approval's
// payment_cents read from the database; nothing in tool input or email text can change it.
//
// Adapted from quote-broker@8a68559 src/payments/guard.ts (Partner; Stripe). Kept rules 1–7
// (approval exists for this job, idempotent repeat, approved and unexpired, exact quote/business/
// amount, spend cap, payable job state). Added for x402 over email (Haggle v3): an in-flight
// payment blocks a second one, the quote must still be current and unrevised, and the challenge
// must come from the approved business on its own thread with a trusted sender, on base-sepolia
// in Base Sepolia USDC, for exactly the approved amount in base units, to an unchanged payee,
// with time left to settle.
import { centsToUsdcBaseUnits } from "../money.ts";

export const X402_NETWORK = "base-sepolia";
/** Circle's test USDC on Base Sepolia. */
export const BASE_SEPOLIA_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
export const MIN_SETTLEMENT_HEADROOM_SEC = 60;

/** Rules 1–7, shared by both rails (Stripe test mode and x402): the approval itself. */
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

export interface X402GuardInput {
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
  /** The parsed x402 challenge plus what the engine verified about the email carrying it. */
  challenge: {
    business_id: string; // business the inbound matcher attributed the email to
    sender_trusted: boolean; // isTrustedSender anchored to that business's snapshot address
    thread_matched: boolean; // arrived on that business's job thread
    network: string;
    asset: string;
    amount_base_units: string;
    pay_to: string;
    expires_at: string;
  } | null;
  /** pay_to from an earlier challenge by the same business on this job, if any. */
  knownPayTo: string | null;
  existingPayment: { id: string; status: string } | null;
  spendCapCents: number;
  now: Date;
}

export type X402GuardCode =
  | "APPROVAL_NOT_FOUND"
  | "PAYMENT_IN_FLIGHT"
  | "APPROVAL_PENDING"
  | "APPROVAL_DECLINED"
  | "APPROVAL_EXPIRED"
  | "QUOTE_CHANGED"
  | "AMOUNT_MISMATCH"
  | "OVER_SPEND_CAP"
  | "JOB_NOT_READY"
  | "AWAITING_INVOICE"
  | "UNTRUSTED_PAYEE"
  | "WRONG_NETWORK"
  | "PAYEE_CHANGED"
  | "CHALLENGE_EXPIRED"
  | "SIGNING_REFUSED";

export type X402GuardResult =
  | { ok: true; amountBaseUnits: string; existingPayment?: { id: string; status: string } }
  | { ok: false; code: X402GuardCode; existingPayment?: { id: string; status: string } };

const deny = (code: X402GuardCode, existingPayment?: { id: string; status: string }): X402GuardResult =>
  existingPayment ? { ok: false, code, existingPayment } : { ok: false, code };

const IN_FLIGHT = new Set(["signed", "sent"]);

export function checkX402PaymentAllowed(i: X402GuardInput): X402GuardResult {
  const { approval, challenge } = i;

  // 1–7. The approval itself (shared with the Stripe rail).
  const base = checkApprovedPayment(i, IN_FLIGHT);
  if (!base.ok) return deny(base.code, base.existingPayment);
  if (base.existingPayment) return { ok: true, amountBaseUnits: centsToUsdcBaseUnits(approval!.payment_cents), existingPayment: base.existingPayment };

  // 8. An invoice has to exist before anything is signed.
  if (!challenge) return deny("AWAITING_INVOICE");

  // 9. The invoice comes from the approved business, authenticated, on its own thread.
  if (challenge.business_id !== approval!.business_id || !challenge.sender_trusted || !challenge.thread_matched) {
    return deny("UNTRUSTED_PAYEE");
  }

  // 10. Testnet USDC only.
  if (challenge.network !== X402_NETWORK || challenge.asset.toLowerCase() !== BASE_SEPOLIA_USDC) return deny("WRONG_NETWORK");

  // 11. Exactly the approved amount, in base units (no rounding, no "close enough").
  const amountBaseUnits = centsToUsdcBaseUnits(approval!.payment_cents);
  if (challenge.amount_base_units !== amountBaseUnits) return deny("AMOUNT_MISMATCH");

  // 12. The payee address can't change between challenges from the same business.
  if (i.knownPayTo !== null && challenge.pay_to.toLowerCase() !== i.knownPayTo.toLowerCase()) return deny("PAYEE_CHANGED");

  // 13. Enough time left for Primitive to verify and settle.
  if (Date.parse(challenge.expires_at) - i.now.getTime() < MIN_SETTLEMENT_HEADROOM_SEC * 1000) return deny("CHALLENGE_EXPIRED");

  return { ok: true, amountBaseUnits };
}
