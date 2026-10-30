// Pure display helpers for the deal dashboard: plain words for states, the step timeline, money and
// time formatting, and quote ordering. No I/O; tested in tests/dashboard.test.ts.
import type { BoardQuote, DealBoardView } from "./types";

const STATE_WORDS: Record<string, string> = {
  created: "Starting",
  contacting: "Contacting businesses",
  collecting: "Collecting quotes",
  negotiating: "Negotiating",
  awaiting_approval: "Waiting for your approval",
  paying: "Paying",
  paid: "Paid",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
  failed: "Stopped",
};

/** A job state in plain words ("awaiting_approval" -> "Waiting for your approval"). */
export function stateWords(state: string): string {
  return STATE_WORDS[state] ?? state.replace(/_/g, " ");
}

/** States after which nothing more happens on a deal (the live stream stops). */
export const TERMINAL_STATES = new Set(["paid", "confirmed", "cancelled", "failed"]);
export const isTerminal = (state: string) => TERMINAL_STATES.has(state);

/** Chip tone for a state: win (done well), risk (stopped), warn (needs the human), info (in progress). */
export function stateTone(state: string): "win" | "risk" | "warn" | "info" {
  if (state === "paid" || state === "confirmed") return "win";
  if (state === "cancelled" || state === "failed") return "risk";
  if (state === "awaiting_approval") return "warn";
  return "info";
}

export type StepStatus = "done" | "current" | "todo";
export interface TimelineStep {
  key: string;
  label: string;
  status: StepStatus;
}

const ORDER = ["contacting", "collecting", "negotiating", "awaiting_approval", "finish"] as const;

/**
 * The deal's step timeline: contacting -> collecting -> negotiating -> awaiting approval -> paying/paid
 * or confirmed. The last step's label follows the state. Cancelled/failed deals keep the steps but
 * none is current (the page shows the stop separately); `stopped` says so.
 */
export function timeline(state: string): { steps: TimelineStep[]; stopped: boolean } {
  const finishLabel = state === "confirmed" ? "Confirmed" : state === "paid" ? "Paid" : state === "paying" ? "Paying" : "Paid or confirmed";
  const labels: Record<(typeof ORDER)[number], string> = {
    contacting: "Contacting",
    collecting: "Collecting quotes",
    negotiating: "Negotiating",
    awaiting_approval: "Awaiting approval",
    finish: finishLabel,
  };
  const stopped = state === "cancelled" || state === "failed";
  const at: number =
    state === "created" ? 0
      : state === "paying" ? 4
      : state === "paid" || state === "confirmed" ? 5
      : Math.max(-1, (ORDER as readonly string[]).indexOf(state));
  const steps = ORDER.map((key, i) => ({
    key,
    label: labels[key],
    status: (stopped || at < 0 ? "todo" : i < at ? "done" : i === at ? "current" : "todo") as StepStatus,
  }));
  return { steps, stopped };
}

/**
 * The deal page's next step, in words for the person reading it. board.next is written for an agent
 * (tool names, ids, cursors), so the page never shows it; this reads the same board instead.
 */
export function humanNext(board: Pick<DealBoardView, "job" | "open_questions" | "businesses" | "quotes" | "purchase" | "ready">): string {
  const state = board.job?.state ?? "created";
  const asked = board.open_questions ?? [];
  if (asked.length === 1) return `${asked[0]!.business} asked a question. Answer it below so it can quote.`;
  if (asked.length > 1) return `${asked.length} businesses asked questions. Answer them below so they can quote.`;
  if (board.purchase?.next) return board.purchase.next;
  const quoted = board.quotes.filter((q) => q.total_usd !== null).length;
  const asking = board.businesses.length;
  switch (state) {
    case "created":
    case "contacting":
      return "Haggle is contacting the businesses. Replies show up here as they arrive.";
    case "collecting":
      return `Waiting for quotes${asking ? `: ${quoted} of ${asking} businesses have quoted so far` : ""}. This page updates by itself.`;
    case "negotiating":
      return "Haggle is negotiating with real competing quotes. Final prices show up here.";
    case "awaiting_approval":
      return board.ready ? "The quotes are final. Compare them and approve the one you want." : "Compare the quotes and approve the one you want.";
    case "paying":
      return "Your approval is recorded. Follow the purchase steps on the approved quote.";
    case "paid":
    case "confirmed":
      return "Done. This deal is finished.";
    case "cancelled":
    case "failed":
      return "This deal was stopped. Nothing more will be sent.";
    default:
      return stateWords(state);
  }
}

/** "$1,234" or "$1,234.50"; null/undefined -> "not stated" (a missing total is unknown, never $0). */
export function money(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "not stated";
  const cents = Math.round(n * 100) % 100 !== 0;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })}`;
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", else "Oct 20, 2026". Bad input -> "". */
export function ago(iso: string | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "2026-10-22T15:04:00Z" -> "Oct 22, 15:04 UTC" (stable on the server; no locale guessing). */
export function stamp(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${date}, ${d.toISOString().slice(11, 16)} UTC`;
}

const CHANNEL_WORDS: Record<string, string> = { email: "Email", phone: "Phone call", a2a: "Agent (A2A)", imessage: "Text" };
export const channelWords = (c: string) => CHANNEL_WORDS[c] ?? c;

const STATUS_WORDS: Record<string, string> = {
  contacted: "Contacted", ringing: "Ringing", on_call: "On a call", quoted: "Quoted", negotiating: "Negotiating",
  won: "Won", declined: "Declined", no_reply: "No reply", unavailable: "Can't reach",
};
export const businessStatusWords = (s: string) => STATUS_WORDS[s] ?? s.replace(/_/g, " ");

/** Flags that mean danger (shown in the risk color). */
const RISK_FLAGS = new Set(["external_payment_link", "prompt_injection", "unverified_sender", "conflicting_numbers", "requirement_unmet", "over_budget"]);
export const flagTone = (f: string): "risk" | "warn" => (RISK_FLAGS.has(f) ? "risk" : "warn");
const FLAG_WORDS: Record<string, string> = {
  external_payment_link: "asked to pay at a link",
  prompt_injection: "suspicious instructions",
  unverified_sender: "unverified sender",
  approximate_total: "approximate total",
};
export const flagWords = (f: string) => FLAG_WORDS[f] ?? f.replace(/_/g, " ");

const PRICE_WORDS: Record<string, string> = { good: "Good price", typical: "Typical price", high: "High price" };
export const priceCheckWords = (p: string | undefined) => (p ? PRICE_WORDS[p] ?? p : "");

export type QuoteRank = "recommended" | "eligible" | "other" | "excluded" | "old";

/** Where a quote sits on the comparison: recommended, approvable, other current, excluded, or an old version. */
export function quoteRank(q: BoardQuote, board: Pick<DealBoardView, "recommended_quote_id" | "quote_status" | "rejected">): QuoteRank {
  if (q.status && q.status !== "current") return "old";
  if (board.recommended_quote_id === q.quote_id) return "recommended";
  if (board.rejected?.some((r) => r.quote_id === q.quote_id) || q.excluded_reason) return "excluded";
  const approvable = board.quote_status?.[q.quote_id]?.approvable ?? q.eligible;
  return approvable ? "eligible" : "other";
}

const RANK_ORDER: Record<QuoteRank, number> = { recommended: 0, eligible: 1, other: 2, excluded: 3, old: 4 };

/** Quotes for the comparison: recommended first, then approvable, other current, excluded, old versions; the server's ranking order within each. */
export function sortQuotes(board: Pick<DealBoardView, "quotes" | "recommended_quote_id" | "quote_status" | "rejected">): { quote: BoardQuote; rank: QuoteRank }[] {
  return board.quotes
    .map((quote, i) => ({ quote, rank: quoteRank(quote, board), i }))
    .sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank] || a.i - b.i)
    .map(({ quote, rank }) => ({ quote, rank }));
}

/** True when the human may approve this quote now (the server decides; absent status falls back to q.eligible). */
export function isApprovable(q: BoardQuote, board: Pick<DealBoardView, "quote_status">): boolean {
  if (q.total_usd === null || (q.status && q.status !== "current")) return false;
  return board.quote_status?.[q.quote_id]?.approvable ?? q.eligible ?? false;
}

/** Why the recommended quote won, in one line, from whatever the board carries. */
export function recommendationReason(board: Pick<DealBoardView, "recommended_quote_id" | "selection" | "value" | "recommendation_note">): string | null {
  const id = board.recommended_quote_id;
  if (!id) return null;
  const sel = board.selection?.[id];
  if (sel && sel.status === "recommended" && sel.reason) return sel.reason;
  if (board.value?.explanation?.winner) return board.value.explanation.winner;
  return board.recommendation_note ?? null;
}

/** "40 people · Oct 24 · SF" from a list_deals row (missing parts left out). */
export function dealLine(d: { quantity?: number; unit?: string; date?: string; area?: string }): string {
  return [d.quantity !== undefined ? `${d.quantity} ${d.unit ?? "people"}` : null, d.date, d.area].filter(Boolean).join(" · ");
}
