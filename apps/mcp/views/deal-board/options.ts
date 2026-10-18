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
  /**
   * Choose this quote now. `pays` = the approval pays `amount` (the deposit, else the total).
   * `replaces`: the business whose texted "all quotes are in" suggestion this choice replaces.
   */
  | { kind: "choose"; label: string; pays: boolean; amount?: number; replaces?: string }
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

/** Haggle's own pending "all quotes are in" suggestion (texted to the human): it never locks the other options. */
export function replaceableApproval(board: Pick<DealBoard, "approval">) {
  const a = activeApproval(board);
  return a && a.status === "pending" && a.replaceable === true ? a : null;
}

/** The approval the human (or agent) actually chose: active and not just Haggle's texted suggestion. */
export function chosenApproval(board: Pick<DealBoard, "approval">) {
  const a = activeApproval(board);
  return a && !replaceableApproval(board) ? a : null;
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
  const suggestion = replaceableApproval(board);
  if (suggestion) {
    // Haggle texted its recommendation; choosing another option replaces it (the engine does that).
    const holder = board.quotes.find((x) => x.quote_id === suggestion.quote_id)?.business ?? "the recommended quote";
    const amount = payNow(q);
    return { kind: "choose", label: chooseLabel(q), pays: amount !== undefined, ...(amount !== undefined ? { amount } : {}), replaces: holder };
  }
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

type NegotiationBoard = Pick<DealBoard, "job" | "negotiation">;

/** The latest counteroffer round's steps (the one negotiating now, or the last one). */
function latestRound(board: NegotiationBoard) {
  const steps = board.negotiation ?? [];
  const round = Math.max(0, ...steps.map((n) => n.round));
  return steps.filter((n) => n.round === round);
}

/**
 * One line while Haggle negotiates, e.g. "Negotiating: Mission Eats will be called back at 12:25 AM to
 * match $1,150 · Sunset Kitchen lowered to $2,302". Null when no round is running. `time` formats an
 * ISO time for the viewer (local clock).
 */
export function negotiationLine(board: NegotiationBoard, time: (iso: string) => string): string | null {
  if (board.job.state !== "negotiating") return null;
  const steps = latestRound(board);
  if (!steps.length) return null;
  const parts = steps.map((n) => {
    const target = money(n.target_total_usd);
    if (n.outcome_total_usd === null) {
      if (n.scheduled_for) return `${n.business} will be called back at ${time(n.scheduled_for)} to match ${target}`;
      return n.channel === "phone" ? `calling ${n.business} back to match ${target}` : `${n.business} asked to match ${target}${n.channel === "imessage" ? " by text" : ""}, waiting`;
    }
    if (n.outcome_total_usd <= n.target_total_usd) return `${n.business} matched at ${money(n.outcome_total_usd)}`;
    if (n.from_total_usd !== undefined && n.outcome_total_usd < n.from_total_usd) return `${n.business} lowered to ${money(n.outcome_total_usd)}`;
    return `${n.business} stayed at ${money(n.outcome_total_usd)}`;
  });
  return `Negotiating: ${parts.join(" · ")}`;
}

/** The choose-confirm warning while counteroffers are still out (choosing ends the deal and drops them). */
export function negotiationWarning(board: NegotiationBoard): string | null {
  if (board.job.state !== "negotiating") return null;
  const waiting = latestRound(board).filter((n) => n.outcome_total_usd === null);
  if (!waiting.length) return null;
  return `Negotiation still running (${waiting.map((n) => n.business).join(", ")} still to answer): choosing now cancels pending counteroffers.`;
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
    holder ? `approval for ${holder}: ${held!.status}${replaceableApproval(board) ? " (Haggle's texted recommendation; choosing another option replaces it)" : ""}` : null,
    board.job.state === "negotiating" && (board.negotiation ?? []).some((n) => n.outcome_total_usd === null) ? "negotiation round still running" : null,
    board.payment?.status === "settled" ? "deposit paid" : null,
    "The human chooses and approves on the board",
  ];
  return `${parts.filter(Boolean).join("; ")}.`;
}
