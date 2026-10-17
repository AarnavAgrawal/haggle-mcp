// PURE: may this payment happen? (DESIGN.md §14.2)
//
// PAIR-WRITTEN FILE (§25): review line by line. This is the last line of
// defense before money moves. Rules run in order and the first failure wins.
// The amount charged is always approval.amount_cents read from the database;
// nothing in tool input or email text can change it.

export interface GuardInput {
  job: { id: string; status: string };
  approval: {
    id: string;
    job_id: string;
    quote_id: string;
    vendor_id: string;
    amount_cents: number;
    status: string;
    expires_at: string;
  } | null;
  quote: { id: string; vendor_id: string; deposit_cents: number | null } | null;
  existingPayment: { id: string; status: string } | null;
  spendCapCents: number;
  now: Date;
}

export type GuardCode =
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_PENDING"
  | "APPROVAL_DECLINED"
  | "APPROVAL_EXPIRED"
  | "AMOUNT_MISMATCH"
  | "OVER_SPEND_CAP"
  | "JOB_NOT_READY";

export type GuardResult =
  | { ok: true; existingPayment?: { id: string; status: string } }
  | { ok: false; code: GuardCode };

const deny = (code: GuardCode): GuardResult => ({ ok: false, code });

export function checkPaymentAllowed(i: GuardInput): GuardResult {
  const { approval, quote } = i;

  // 1. The approval exists and belongs to this job.
  if (!approval || approval.job_id !== i.job.id) return deny("APPROVAL_NOT_FOUND");

  // 2. Already paid for this approval: return it (idempotent success).
  if (i.existingPayment?.status === "succeeded") return { ok: true, existingPayment: i.existingPayment };

  // 3. The human approved it, and it hasn't been used.
  switch (approval.status) {
    case "approved":
      break;
    case "pending":
      return deny("APPROVAL_PENDING");
    case "declined":
      return deny("APPROVAL_DECLINED");
    default: // expired, used (without a recorded payment), or anything unknown
      return deny("APPROVAL_EXPIRED");
  }

  // 4. Still within its time limit.
  if (i.now.getTime() > Date.parse(approval.expires_at)) return deny("APPROVAL_EXPIRED");

  // 5. Exactly the quote, vendor, and amount the human saw.
  if (
    !quote ||
    quote.id !== approval.quote_id ||
    quote.vendor_id !== approval.vendor_id ||
    quote.deposit_cents !== approval.amount_cents ||
    approval.amount_cents <= 0
  ) {
    return deny("AMOUNT_MISMATCH");
  }

  // 6. Under the hard spend cap.
  if (approval.amount_cents > i.spendCapCents) return deny("OVER_SPEND_CAP");

  // 7. The job is in a payable state.
  if (i.job.status !== "approved" && i.job.status !== "payment_failed") return deny("JOB_NOT_READY");

  return { ok: true };
}
