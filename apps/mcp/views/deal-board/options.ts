/**
 * Which quotes the human can choose on the deal board, and what the board tells the model. Pure
 * logic (tested in tests/dealBoard.test.ts); the view renders it.
 *
 * The board recommends one quote but every safe option can be chosen: the engine refuses only
 * unsafe quotes (scam / pay-elsewhere links, injected instructions, unverified senders, declined),
 * which arrive in `rejected` or as safety flags. Preferences (over budget, an unconfirmed
 * requirement) are caveats shown on the quote, never a block. The engine keeps one approval per
 * job: while one is pending or approved, the other options say so instead of failing on click.
 *
 * Business text is untrusted: the model context is built from names, totals, ids and states only.
 */
import type { DealBoard, Quote } from "@haggle/core";

/**
 * Flags the engine refuses to approve (its safety verdict, mirrored so a stale board never offers
 * them). Red preference chips (over budget, a missed requirement) are caveats, not in this set.
 */
const SAFETY_FLAGS = new Set(["external_payment_link", "prompt_injection", "unverified_sender"]);

/** Approval statuses that no longer hold the job (the human can choose again). */
const RELEASED = new Set(["declined", "expired", "locked", "refused"]);
/** States where approve(job_id, quote_id) starts a new approval. */
const CHOOSABLE_STATES = new Set(["collecting", "negotiating"]);
const DONE_STATES = new Set(["paid", "confirmed", "cancelled", "failed"]);

export type Choice =
  /** No button: an unsafe quote, or the deal is over. */
  | { kind: "none" }
  /** Choose this quote now. `pays` = the approval pays `amount` (the deposit, else the total). */
  | { kind: "choose"; label: string; pays: boolean; amount?: number }
  /** Another quote holds the job's one approval: say which, and how to free it. */
  | { kind: "blocked"; holder: string; reason: string }
  /** This quote holds the approval: the board shows its approve → pay → receipt steps. */
  | { kind: "held" };

const knownTotal = (q: Quote) => q.total_known !== false && q.total_usd > 0;
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** The quote's safety verdict: rejected by the engine or carrying a risk flag. */
export function isUnsafe(board: Pick<DealBoard, "rejected">, q: Quote): boolean {
  return Boolean(board.rejected?.some((r) => r.quote_id === q.quote_id)) || q.flags.some((f) => SAFETY_FLAGS.has(f));
}

/** The approval that still holds the job (pending, approved, used), or null. */
export function activeApproval(board: Pick<DealBoard, "approval">) {
  const a = board.approval;
  return a && !RELEASED.has(a.status) ? a : null;
}

/** What approving this quote pays now (the engine's rule: the deposit, else the full total). */
export function payNow(q: Quote): number | undefined {
  if (q.deposit_usd !== undefined && q.deposit_usd > 0) return q.deposit_usd;
  return knownTotal(q) ? q.total_usd : undefined;
}

export function chooseLabel(q: Quote): string {
  const amount = payNow(q);
  if (amount === undefined) return "Choose (confirm only, nothing paid)";
  return q.deposit_usd !== undefined && q.deposit_usd > 0 ? `Choose & pay ${money(amount)} deposit` : `Choose & pay ${money(amount)}`;
}

export function choiceFor(board: Pick<DealBoard, "job" | "quotes" | "rejected" | "approval" | "payment">, q: Quote): Choice {
  const held = activeApproval(board);
  if (held?.quote_id === q.quote_id) return { kind: "held" };
  // A settled payment or confirmed order on this quote is still shown by its own steps.
  if (board.approval?.quote_id === q.quote_id && (board.payment?.status === "settled" || board.job.state === "confirmed")) return { kind: "held" };
  if (isUnsafe(board, q) || DONE_STATES.has(board.job.state)) return { kind: "none" };
  if (held) {
    const holder = board.quotes.find((x) => x.quote_id === held.quote_id)?.business ?? "Another quote";
    const reason = held.status === "pending"
      ? `One approval at a time: ${holder} is waiting for your answer. Decline it (reply NO with the code) or let it expire, then choose this one.`
      : `You already approved ${holder}. Cancel that deal to choose another.`;
    return { kind: "blocked", holder, reason };
  }
  if (!CHOOSABLE_STATES.has(board.job.state)) return { kind: "none" };
  const amount = payNow(q);
  return { kind: "choose", label: chooseLabel(q), pays: amount !== undefined, ...(amount !== undefined ? { amount } : {}) };
}

/** Count of quotes the human could choose right now (for the ladder's header line). */
export const choosableCount = (board: Pick<DealBoard, "job" | "quotes" | "rejected" | "approval" | "payment">) =>
  board.quotes.filter((q) => choiceFor(board, q).kind === "choose").length;

/**
 * What the model can see about the board without anyone posting in the chat: ids, names, totals and
 * states only (never a business's own words). Refreshed whenever the board updates itself.
 */
export function boardContext(board: DealBoard, recommendedId: string | undefined): string {
  const safe = board.quotes.filter((q) => !isUnsafe(board, q));
  const opts = safe
    .slice(0, 8)
    .map((q) => `${q.business} ${knownTotal(q) ? money(q.total_usd) : "total not stated"} (quote_id ${q.quote_id}${q.quote_id === recommendedId ? ", recommended" : ""})`);
  const held = activeApproval(board);
  const holder = held && board.quotes.find((q) => q.quote_id === held.quote_id)?.business;
  const parts = [
    `Haggle deal board for ${board.job.id} is open in the chat and updates itself (no need to call get_quotes or open_haggle to show it): state ${board.job.state}`,
    `${board.businesses.length} businesses contacted, ${board.quotes.length} quote(s)`,
    opts.length ? `options: ${opts.join("; ")}` : "no options yet",
    board.open_questions.length ? `${board.open_questions.length} open business question(s)` : null,
    holder ? `approval for ${holder}: ${held!.status}` : null,
    board.payment?.status === "settled" ? "deposit paid" : null,
    "The human chooses and approves on the board",
  ];
  return `${parts.filter(Boolean).join("; ")}.`;
}
