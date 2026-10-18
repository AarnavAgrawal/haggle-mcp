/**
 * Which quotes the human can choose on the deal board, and what the board tells the model. Pure
 * logic (tested in tests/dealBoard.test.ts); the view renders it.
 *
 * The board recommends one quote but every safe option can be chosen (decision 5): the engine refuses
 * only unsafe quotes (scam / pay-elsewhere links, injected instructions, unverified senders, declined),
 * which arrive in `rejected` or as safety flags. Preferences (over budget or over your limit, an
 * unconfirmed requirement) are caveats shown on the confirm step, never a block. A quote without a
 * firm total (approximate, all-in not confirmed, or none stated) can't be approved yet (decisions 19,
 * 34): it shows why instead of a button. Choosing approves; a separate Pay charges (decision 2). The
 * engine keeps one approval per job: while one is pending or approved, the other options say so.
 *
 * Business text is untrusted: the model context is built from names, totals, ids and states only.
 */
import type { DealBoard, Quote } from "@haggle/core";

/** A board quote: a total the business never stated is null (or 0 with total_known: false), never a price. */
export type OptQuote = Omit<Quote, "total_usd"> & { total_usd: number | null };
/** Per-quote approvability as the server reports it (apps/mcp/src/views.ts DealBoardPlus.quote_status). */
export type QuoteStatus = { approvable: boolean; approximate?: boolean; block?: { code: string; reason: string } };
type Base = Omit<DealBoard, "quotes"> & { quotes: OptQuote[]; quote_status?: Record<string, QuoteStatus> };
type ChoiceBoard = Pick<Base, "job" | "quotes" | "rejected" | "approval" | "payment" | "quote_status">;

/**
 * Flags the engine refuses to approve (its safety verdict, mirrored so a stale board never offers
 * them). Red preference chips (over budget, a missed requirement) are caveats, not in this set.
 */
const SAFETY_FLAGS = new Set(["external_payment_link", "prompt_injection", "unverified_sender"]);

/** Approval statuses that no longer hold the job (the human can choose again). */
const RELEASED = new Set(["declined", "expired", "locked", "refused"]);
/** States where a choice starts a new approval. */
const CHOOSABLE_STATES = new Set(["collecting", "negotiating"]);
const DONE_STATES = new Set(["paid", "confirmed", "cancelled", "failed"]);

export type Choice =
  /** No button: an unsafe quote, quotes not in yet, or the deal is over. */
  | { kind: "none" }
  /**
   * Choose this quote: a confirm step, then the approval. `amount` is what Pay charges afterwards: the
   * deposit (`deposit: true`), else the full total. `replaces`: the business whose texted "all quotes
   * are in" suggestion this choice replaces.
   */
  | { kind: "choose"; label: string; confirm: string; amount: number; deposit: boolean; replaces?: string }
  /** Safe, but it can't be approved yet (no firm total, over the per-payment ceiling, …): why. */
  | { kind: "unapprovable"; code: string; reason: string }
  /** Another quote holds the job's one approval: say which, and how to free it. */
  | { kind: "blocked"; holder: string; reason: string }
  /** This quote holds the approval: the board shows its approve → pay → receipt steps. */
  | { kind: "held" };

/** True when the business stated a real total (never show or pay "$0" for an unknown one). */
export function knownTotal<T extends { total_usd: number | null; total_known?: boolean }>(q: T): q is T & { total_usd: number } {
  return q.total_known !== false && q.total_usd !== null && q.total_usd > 0;
}
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** The quote's safety verdict: rejected by the engine or carrying a risk flag. */
export function isUnsafe(board: Pick<DealBoard, "rejected">, q: Pick<OptQuote, "quote_id" | "flags">): boolean {
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

/** What Pay charges once this quote is approved (the engine's rule): the deposit, else the full total; never $0. */
export function payNow(q: Pick<OptQuote, "total_usd" | "total_known" | "deposit_usd">): number | undefined {
  if (q.deposit_usd !== undefined && q.deposit_usd > 0) return q.deposit_usd;
  return knownTotal(q) ? q.total_usd : undefined;
}

/** The approve button's words: "Approve $200 deposit" or "Approve $1,080 (full total)". */
export function approveLabel(q: Pick<OptQuote, "total_usd" | "total_known" | "deposit_usd">): string {
  const amount = payNow(q);
  if (amount === undefined) return "Approve";
  return q.deposit_usd !== undefined && q.deposit_usd > 0 ? `Approve ${money(amount)} deposit` : `Approve ${money(amount)} (full total)`;
}

/**
 * Why this quote can't be approved yet, or null: the server's decision when it sent one
 * (quote_status), else no stated total or an approximate one. Confirm-only gets no exemption.
 */
export function approvalBlock(board: Pick<Base, "quote_status">, q: OptQuote): { code: string; reason: string } | null {
  const st = board.quote_status?.[q.quote_id];
  if (st && !st.approvable) return st.block ?? { code: "not_approvable", reason: "Haggle can't approve this quote yet." };
  if (!knownTotal(q)) return { code: "no_total", reason: `${q.business} hasn't stated a total yet; it can be chosen once they do.` };
  if (q.flags.includes("approximate_total")) return { code: "total_not_firm", reason: `${q.business} gave an approximate total; it can be chosen once they confirm a firm one.` };
  return null;
}

export function choiceFor(board: ChoiceBoard, q: OptQuote): Choice {
  const held = activeApproval(board);
  if (held?.quote_id === q.quote_id) return { kind: "held" };
  // A settled payment or confirmed order on this quote is still shown by its own steps.
  if (board.approval?.quote_id === q.quote_id && (board.payment?.status === "settled" || board.job.state === "confirmed")) return { kind: "held" };
  if (isUnsafe(board, q) || DONE_STATES.has(board.job.state)) return { kind: "none" };
  const suggestion = replaceableApproval(board);
  if (!suggestion && !held && !CHOOSABLE_STATES.has(board.job.state)) return { kind: "none" };
  const block = approvalBlock(board, q);
  if (block) return { kind: "unapprovable", ...block };
  const amount = payNow(q)!;
  const choose = { kind: "choose" as const, label: "Choose this", confirm: approveLabel(q), amount, deposit: q.deposit_usd !== undefined && q.deposit_usd > 0 };
  if (suggestion) {
    // Haggle texted its recommendation; choosing another option replaces it (the engine does that).
    const holder = board.quotes.find((x) => x.quote_id === suggestion.quote_id)?.business ?? "the recommended quote";
    return { ...choose, replaces: holder };
  }
  if (held) {
    const holder = board.quotes.find((x) => x.quote_id === held.quote_id)?.business ?? "Another quote";
    const reason = held.status === "pending"
      ? `One approval at a time: ${holder} is waiting for your answer. Decline it (reply NO with the code) or let it expire, then choose this one.`
      : `You already approved ${holder}. Cancel that deal to choose another.`;
    return { kind: "blocked", holder, reason };
  }
  return choose;
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

/** Count of quotes the human could choose right now (for the quotes header line). */
export const choosableCount = (board: ChoiceBoard) => board.quotes.filter((q) => choiceFor(board, q).kind === "choose").length;

/**
 * What the model can see about the board without anyone posting in the chat: ids, names, totals and
 * states only (never a business's own words). Refreshed whenever the board updates itself.
 */
export function boardContext(board: Omit<Base, "quote_status">, recommendedId: string | undefined): string {
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
    board.payment?.status === "settled" ? "paid" : board.job.state === "confirmed" ? "order confirmed, nothing paid" : null,
    "The human chooses and approves on the board; approving charges nothing until pay",
  ];
  return `${parts.filter(Boolean).join("; ")}.`;
}
