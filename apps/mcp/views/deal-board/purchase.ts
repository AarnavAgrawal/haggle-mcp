/**
 * The manual payment handoff on the deal board (HAGGLE_PAYMENTS=manual): Haggle moves no money. After
 * the human approves, the business confirms the booking in writing, sends how to pay (untrusted text),
 * the human pays it directly and reports it (a PAID text, or the Haggle web app), and the business
 * confirms receipt. Pure logic (tested in tests/dealBoard.test.ts); the view renders it. Wording mirrors
 * the web app (apps/web/components/approval/PurchaseSteps.tsx).
 *
 * Never a code: the human's step names "the code from Haggle's text" and nothing else. The view has no
 * button that records a payment or a booking; only the human's PAID/BOOKED texts or the web app do.
 */

/** The board's purchase object (apps/mcp/src/views.ts DealBoardPlus.purchase); the fields read here. */
export type PurchaseLike = {
  stage: string;
  rail: "manual";
  booked: boolean;
  booked_by_human?: true;
  money_verified: boolean;
  amount_usd: number;
  total_usd: number;
  stalled?: true;
  confirm_only?: true;
};

/** Job states after which the board stops polling (unless a manual payment is only reported; see keepPolling). */
export const TERMINAL_STATES = new Set(["paid", "confirmed", "cancelled", "failed"]);

export const STEP_LABELS = [
  "Vendor confirms the booking in writing",
  "Vendor sends how to pay",
  "You pay the vendor directly",
  "Vendor confirms it received the money",
  "Done",
] as const;

const STEP_OF: Record<string, 0 | 1 | 2 | 3 | 4> = {
  awaiting_vendor_confirmation: 0, instructions_requested: 1, instructions_received: 2, human_reported_paid: 3, settled_verified: 4,
};

/** Where a stage sits on the five steps; null for the stages off that path (declined, changed, cancelled, confirm-only, refused). */
export function purchaseStep(stage: string): 0 | 1 | 2 | 3 | 4 | null {
  return STEP_OF[stage] ?? null;
}

/** Nothing more can happen: the business confirmed it received the money, or the deal was cancelled before payment. */
export function purchaseSettled(stage: string): boolean {
  return stage === "settled_verified" || stage === "cancelled";
}

/** The purchase reached its good end: money confirmed by the business, or a confirm-only order confirmed. */
export function purchaseDone(stage: string): boolean {
  return stage === "settled_verified" || stage === "order_confirmed";
}

/** The manual rail: from the purchase after approval, or the server's payment_rail before any approval. */
export const isManual = (board: { purchase?: { rail: string } | null; payment_rail?: string }): boolean => board.purchase?.rail === "manual" || board.payment_rail === "manual";

/**
 * Keep the board's live updates running? Every non-terminal job state, and also a "paid" job on the
 * manual rail whose payment is only reported by the customer (the business's confirmation of receipt
 * can still arrive). A Stripe/simulated "paid" is final.
 */
export function keepPolling(jobState: string, purchase: Pick<PurchaseLike, "stage" | "rail"> | null | undefined): boolean {
  if (!TERMINAL_STATES.has(jobState)) return true;
  return jobState === "paid" && purchase?.rail === "manual" && !purchaseSettled(purchase.stage);
}

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** "the $200 deposit" or "the $995 total". */
export function amountWords(p: Pick<PurchaseLike, "amount_usd" | "total_usd">): string {
  return p.amount_usd < p.total_usd ? `the ${money(p.amount_usd)} deposit` : `the ${money(p.amount_usd)} total`;
}

export type Tone = "info" | "you" | "done" | "risk";

/** One sentence: where the purchase is and whose move it is, in the human's terms. */
export function purchaseHeadline(p: PurchaseLike, business: string): { text: string; tone: Tone } {
  const amount = amountWords(p);
  switch (p.stage) {
    case "awaiting_vendor_confirmation":
      return p.stalled
        ? { text: `${business} hasn't confirmed the booking yet. Don't pay anything; see the next step below.`, tone: "you" }
        : { text: `You approved ${business}. Waiting for ${business} to confirm the booking; don't pay anything yet.`, tone: "info" };
    case "instructions_requested":
      return { text: `Booked with ${business}${p.booked_by_human ? " (confirmed by you)" : ""}. Waiting for its payment instructions; Haggle moves no money.`, tone: p.stalled ? "you" : "info" };
    case "instructions_received":
      return { text: `${business} sent payment instructions. Check them with ${business} before you pay ${amount} directly.`, tone: "you" };
    case "human_reported_paid":
      return { text: `You reported paying ${business} ${amount}. Waiting for ${business} to confirm it received the money.`, tone: "info" };
    case "settled_verified":
      return { text: `${business} confirmed it received your ${amount.replace(/^the /, "")}. Done.`, tone: "done" };
    case "order_confirmed":
      return { text: `Order confirmed with ${business}. Haggle takes no payment; you arrange payment with ${business} under its terms.`, tone: "done" };
    case "handoff_refused":
      return { text: `This approval no longer passes Haggle's payment checks, so Haggle didn't ask ${business} how to pay. Don't pay.`, tone: "risk" };
    case "booking_declined":
      return { text: `${business} can't take the booking after all. Nothing was paid; choose another quote.`, tone: "risk" };
    case "booking_changed":
      return { text: `${business} replied with different terms, so the approval was withdrawn. Nothing was paid.`, tone: "risk" };
    case "cancelled":
      return { text: `Cancelled before any payment was reported. Nothing was paid through Haggle; don't pay ${business}.`, tone: "risk" };
    case "cancel_requested_after_payment":
      return { text: `You asked to cancel after reporting a payment to ${business}. Haggle can't refund a payment it never made: contact ${business} directly.`, tone: "risk" };
    default:
      return { text: `Manual payment with ${business}: ${p.stage.replace(/_/g, " ")}. Haggle moves no money.`, tone: "info" };
  }
}

/**
 * The human's own move at this stage, or null when there is none (Haggle or the business acts next).
 * Names the PAID text and, when the web app can record it, the web app. Never a code.
 */
export function yourStep(p: PurchaseLike, business: string, webApp: boolean): string | null {
  if (p.confirm_only) return null;
  const report = `reply PAID with the code from Haggle's text${webApp ? ", or use the Haggle web app" : ""}`;
  switch (p.stage) {
    case "awaiting_vendor_confirmation":
      return `Don't pay ${business} until Haggle tells you the booking is confirmed.`;
    case "instructions_requested":
      return p.stalled ? `Ask ${business} directly how to pay, pay ${amountWords(p)}, then ${report}.` : null;
    case "instructions_received":
      return `Check the instructions with ${business} on a number you already know, pay ${amountWords(p)} directly, then ${report}.`;
    default:
      return null;
  }
}

/** The label over the business's own words (untrusted, plain text). */
export function vendorWordsLabel(kind: "instructions" | "reply", business: string): string {
  return kind === "instructions"
    ? `Payment instructions from ${business}: unverified, confirm them with ${business} on a number you already know before paying`
    : `${business}'s reply (unverified)`;
}

export const LINK_WARNING = "This contains a link. Haggle never opens payment links; don't pay through a link you didn't expect.";

export const CONFIRM_ONLY_NOTE = (business: string) => `Confirm-only order: nothing is paid through Haggle; you arrange payment with ${business} under its terms.`;

/** The deal stepper's last cell ("Pay") under the manual rail. */
export function payStepSub(stage: string): string {
  switch (stage) {
    case "awaiting_vendor_confirmation": return "booking";
    case "instructions_requested": return "awaiting how to pay";
    case "instructions_received": return "your turn";
    case "human_reported_paid": return "reported";
    case "settled_verified": return "vendor confirmed";
    case "order_confirmed": return "nothing to pay";
    default: return "stopped";
  }
}
