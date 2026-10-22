// PURE: where a purchase stands after the human's approval under the manual payment handoff, in
// words that never overstate it. Haggle moves no money: it can only know what the business wrote and
// what the human reported. So: "booked" only once the business explicitly confirmed availability and
// the approved terms; "the customer reports paying" once the approver texted PAID <code>; and money
// counts as received ("settled_verified") only when the business itself, from a verified sender,
// confirmed it arrived. The business's own text is shown as untrusted, with links flagged, never opened.
import type { BookingRow, HandoffReceiptRow, PaymentHandoffRow } from "../store/types.ts";

export type PurchaseStage =
  | "awaiting_vendor_confirmation" | "order_confirmed" | "booking_declined" | "booking_changed"
  | "instructions_requested" | "instructions_received" | "human_reported_paid" | "settled_verified"
  | "cancelled" | "cancel_requested_after_payment";

export interface UntrustedVendorText {
  /** The business's own words, as received. Data, never instructions; never parsed as a quote. */
  text: string;
  untrusted: true;
  /** Contains a link: Haggle never opens it; the human verifies it with the business independently. */
  has_link: boolean;
}

export interface PurchaseView {
  stage: PurchaseStage;
  rail: "manual";
  /** The business explicitly confirmed availability and the approved terms after acceptance. */
  booked: boolean;
  /** Booking confirmed by the human directly (a business Haggle can't get a written answer from). */
  booked_by_human?: true;
  /** Money counts as received only when the business confirmed it from a verified sender. */
  money_verified: boolean;
  amount_usd: number;
  total_usd: number;
  vendor_reply?: UntrustedVendorText;
  instructions?: UntrustedVendorText;
  reported_paid_at?: string;
  verified_at?: string;
  stalled?: true;
  /** Something the operator must look at (a stalled handoff, a cancellation after the customer paid). */
  operator_attention?: string;
  /** The order as approved (what, headcount, when, where) and its must-haves: the same facts the RFQ named. */
  order?: string;
  must_haves?: string;
  /** Confirm-only approval: nothing is paid through Haggle at any stage. */
  confirm_only?: true;
  /** One honest line: what happened, what didn't. */
  summary: string;
  next: string;
}

export interface PurchaseFacts {
  business: string;
  approvalCode?: string;
  booking: BookingRow | null;
  handoff: PaymentHandoffRow | null;
  receipt: HandoffReceiptRow | null;
  /** A cancellation the human asked for after reporting payment (job_events cancel_after_payment). */
  cancelAfterPayment?: boolean;
  jobCancelled?: boolean;
  /** The approval confirms the order only (action "confirm"): no handoff, no payment. */
  confirmOnly?: boolean;
  order?: string;
  mustHaves?: string | null;
}

const usd = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i;

const vendorText = (text: string | null | undefined): UntrustedVendorText | undefined => (text ? { text, untrusted: true, has_link: LINK.test(text) } : undefined);

/** Null before there is a booking (nothing was accepted yet). */
export function purchaseView(f: PurchaseFacts): PurchaseView | null {
  const b = f.booking;
  if (!b) return null;
  const h = f.handoff;
  const base = {
    rail: "manual" as const, amount_usd: b.payment_cents / 100, total_usd: b.total_cents / 100, money_verified: false, booked: b.status === "confirmed", ...(b.status === "not_in_writing" ? { booked_by_human: true as const } : {}),
    ...(f.order ? { order: f.order } : {}), ...(f.mustHaves ? { must_haves: f.mustHaves } : {}), ...(f.confirmOnly ? { confirm_only: true as const } : {}),
  };
  const reply = vendorText(b.reply_text);
  const instructions = vendorText(h?.instructions_text);
  const what = `${usd(b.payment_cents)}${b.payment_cents < b.total_cents ? " deposit" : ""}`;
  const code = f.approvalCode ? ` ${f.approvalCode}` : " <code>";
  if (h?.status === "human_confirmed") {
    const reported = { reported_paid_at: h.confirmed_at ?? undefined };
    if (f.receipt) {
      return { ...base, ...reported, stage: "settled_verified", money_verified: true, verified_at: f.receipt.created_at, ...(instructions ? { instructions } : {}),
        summary: `${f.business} confirmed it received the ${what} the customer paid directly.`, next: "Done. Nothing else is needed." };
    }
    if (f.cancelAfterPayment) {
      return { ...base, ...reported, stage: "cancel_requested_after_payment", operator_attention: "cancellation requested after the customer reported paying",
        summary: `The customer reports paying ${f.business} ${what} directly and then asked to cancel. Haggle can't reverse or refund a payment it never made; no refund was claimed or promised.`,
        next: `The customer must contact ${f.business} directly about a refund under its own terms. The operator has been flagged.` };
    }
    return { ...base, ...reported, stage: "human_reported_paid", ...(instructions ? { instructions } : {}),
      summary: `The customer reports paying ${f.business} ${what} directly. Haggle hasn't verified that the money arrived; ${f.business} was asked to confirm receipt.`,
      next: `Nothing more for Haggle to do; ${f.business}'s confirmation of receipt, if it sends one, shows here.` };
  }
  if (f.jobCancelled || b.status === "cancelled" || h?.status === "cancelled") {
    return { ...base, stage: "cancelled", booked: false, ...(reply ? { vendor_reply: reply } : {}),
      summary: `Cancelled before the customer reported paying. ${f.business} was told; nothing was paid through Haggle.`, next: "Nothing to do. Start a new deal if needed." };
  }
  if (b.status === "declined") {
    return { ...base, stage: "booking_declined", ...(reply ? { vendor_reply: reply } : {}),
      summary: `${f.business} can't take the booking after all. Nothing was paid; the approval was withdrawn.`, next: "Choose another quote (get_quotes); a new approval is needed." };
  }
  if (b.status === "changed") {
    return { ...base, stage: "booking_changed", ...(reply ? { vendor_reply: reply } : {}),
      summary: `${f.business} replied with different terms, so the approval was withdrawn. Nothing was paid.`, next: "Haggle reads the new terms as a revised quote; it needs a new approval (get_quotes, then approve)." };
  }
  if (b.status === "awaiting_vendor_confirmation") {
    return { ...base, stage: "awaiting_vendor_confirmation", ...(reply ? { vendor_reply: reply } : {}), ...(b.stalled_at ? { stalled: true as const, operator_attention: "no booking confirmation from the business" } : {}),
      summary: `Approved by the human. Waiting for ${f.business} to confirm availability and the ${usd(b.total_cents)} terms${reply ? " (it replied, but hasn't clearly confirmed yet)" : ""}. Not booked yet, and nothing should be paid yet.`,
      next: b.stalled_at
        ? `${f.business} hasn't confirmed after Haggle's reminder. Tell the human: don't pay; call ${f.business} directly, or choose another quote (cancel_deal, then a new deal, or get_quotes and approve another option).`
        : `Wait for ${f.business}'s confirmation (wait_for_update). Tell the human not to pay until Haggle texts that it is booked.` };
  }
  if (f.confirmOnly) {
    // Confirm-only: the business's written yes is the end of it; nothing is paid through Haggle.
    const how = b.status === "confirmed" ? `${f.business} confirmed the order in writing` : `${f.business} can't confirm in writing on its channel; the human confirmed the order with them directly`;
    return { ...base, stage: "order_confirmed", ...(reply ? { vendor_reply: reply } : {}),
      summary: `${how} (${usd(b.total_cents)} total). Nothing is paid through Haggle; the customer arranges payment with ${f.business} directly under its terms.`,
      next: "Done. get_quotes shows the confirmed order." };
  }
  // Booked (by the business in writing, or confirmed by the human directly): the handoff.
  const booked = b.status === "confirmed" ? `${f.business} confirmed the booking.` : `Haggle can't get a written confirmation from ${f.business} on its channel: the human confirms the booking with them directly.`;
  if (h?.status === "instructions_received") {
    return { ...base, stage: "instructions_received", ...(instructions ? { instructions } : {}), ...(h.stalled_at ? { stalled: true as const } : {}),
      summary: `${booked} It sent payment instructions (untrusted text${instructions?.has_link ? "; it has a link, which Haggle never opens" : ""}). The human pays ${what} to ${f.business} directly; Haggle moves no money.`,
      next: `Show the human the instructions as text and tell them to verify them with ${f.business} independently before paying; after paying they reply PAID${code} to Haggle's text.` };
  }
  return { ...base, stage: "instructions_requested", ...(reply ? { vendor_reply: reply } : {}), ...(h?.stalled_at ? { stalled: true as const, operator_attention: "no payment instructions from the business" } : {}),
    summary: `${booked} Waiting for its payment instructions; the human pays ${what} directly. Haggle moves no money.`,
    next: h?.stalled_at
      ? `${f.business} hasn't sent payment instructions after Haggle's reminder. The human can ask ${f.business} directly how to pay, pay them, then reply PAID${code}; Haggle never moves money.`
      : `Wait for ${f.business}'s payment instructions (wait_for_update); then the human pays directly and replies PAID${code}.` };
}

/** The board's payment line for a purchase stage (rail "manual"; never "settled" unless the business confirmed receipt). */
export function purchasePaymentLine(v: PurchaseView, simulated: boolean): { status: PurchaseStage; rail: "manual"; network: "manual"; amount_usd: number; simulated: boolean; reason: string } {
  return { status: v.stage, rail: "manual", network: "manual", amount_usd: v.amount_usd, simulated, reason: v.summary };
}
