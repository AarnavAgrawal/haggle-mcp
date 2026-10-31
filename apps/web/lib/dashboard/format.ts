// Pure display helpers for the deal dashboard: plain words for states, the step timeline, money and
// time formatting, and quote ordering. No I/O; tested in tests/dashboard.test.ts.
import type { BoardQuote, DealBoardView, DealRow } from "./types";

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
const RISK_FLAGS = new Set(["external_payment_link", "prompt_injection", "unverified_sender", "conflicting_numbers", "requirement_unmet", "over_budget", "price_implausible"]);
export const flagTone = (f: string): "risk" | "warn" => (RISK_FLAGS.has(f) ? "risk" : "warn");
const FLAG_WORDS: Record<string, string> = {
  external_payment_link: "asked to pay at a link",
  prompt_injection: "suspicious instructions",
  unverified_sender: "unverified sender",
  approximate_total: "approximate total",
  price_implausible: "suspiciously low price",
  price_confirmed_unusual: "unusually low (vendor confirmed)",
  price_unusually_high: "unusually high price",
};
export const flagWords = (f: string) => FLAG_WORDS[f] ?? f.replace(/_/g, " ");

const PRICE_WORDS: Record<string, string> = { good: "Good price", typical: "Typical price", high: "High price", too_low: "Suspiciously low" };
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

const CLIPPED = /(?:…|\.{3})\.?$/;

/** The value ranking's explanation for a person: "Bay Catering: best value 0.77 — $995 …" -> "$995 …". */
export function valueNote(s: string): string {
  return sentence(
    s
      .replace(/^[^:]{1,80}:\s*best value\s+[\d.]+\s*[—–-]\s*/i, "")
      .replace(/^[^:()]{1,80}\(value\s+[\d.]+\):\s*/i, "")
      .trim(),
  );
}

/**
 * The recommendation's reason as a whole sentence, never cut mid-word: the server's compact board
 * clips long reasons ("…best value of the q…"); then it is cut back to its last complete clause, or,
 * when too little is left, the value winner's explanation is used.
 */
export function recommendationSentence(board: Pick<DealBoardView, "recommended_quote_id" | "selection" | "value" | "recommendation_note">): string | null {
  const raw = recommendationReason(board);
  if (!raw) return null;
  let text = sentence(raw.replace(/^(why )?recommended:\s*/i, "").trim());
  if (CLIPPED.test(text)) {
    const cut = text.replace(CLIPPED, "");
    const at = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf("; "));
    text = at > 0 ? cut.slice(0, at) : cut.replace(/\s+\S*$/, "");
    const winner = board.value?.explanation?.winner;
    if (text.length < 20 && winner && !CLIPPED.test(winner.trim())) text = valueNote(winner);
  }
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** "40 people · Oct 24 · SF" from a list_deals row (missing parts left out). */
export function dealLine(d: { quantity?: number; unit?: string; date?: string; area?: string }): string {
  return [d.quantity !== undefined ? `${d.quantity} ${d.unit ?? "people"}` : null, d.date, d.area].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------------------------------
// The deal board (DESIGN.md "Deal board"): status words, the quote sheet's rows, must-haves, the
// activity list and the side column's progress. Pure; tested in tests/dashboard.test.ts.

/** The dot's tone (components/ui/Status): live = happening now, hold = needs you, ok, risk, idle. */
export type Tone = "live" | "ok" | "hold" | "risk" | "idle";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** First letter up, the server's " · " joins as commas: "call ended · completed" -> "Call ended, completed". */
export function sentence(s: string): string {
  const t = s.replace(/\s+·\s+/g, ", ").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/**
 * A server note for a person: no internal ids ("(real quote q_7b52…)", job_…), no snake_case codes
 * ("requirement_unmet" -> "requirement unmet"), sentence case.
 */
export function plainNote(s: string): string {
  const t = s
    .replace(/\s*\((?:[^()]*\s)?(?:q|job|biz|msg|appr)_[A-Za-z0-9]+\)/g, "")
    .replace(/\b(?:q|job|biz|msg|appr)_[A-Za-z0-9]{6,}\b/g, "")
    .replace(/\b([a-z]+)_([a-z_]+)\b/g, (_m, a: string, b: string) => `${a} ${b.replace(/_/g, " ")}`)
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ");
  return sentence(t);
}

/** "Mission Eats'" / "Bay Catering's". */
export const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** The current quote per business (the latest current one, by the server's order). */
function currentQuoteOf(board: Pick<DealBoardView, "quotes">, businessId: string): BoardQuote | undefined {
  return board.quotes.find((q) => q.business_id === businessId && (!q.status || q.status === "current"));
}

type StatusBoard = Pick<DealBoardView, "job" | "businesses" | "quotes" | "open_questions" | "ready" | "approval" | "purchase">;

/** The board header's status line: what is happening now, in the buyer's words, with the dot's tone. */
export function boardStatus(board: StatusBoard): { tone: Tone; words: string } {
  const state = board.job?.state ?? "created";
  const asking = board.businesses.length;
  const quoted = new Set(board.quotes.filter((q) => q.total_usd !== null && (!q.status || q.status === "current")).map((q) => q.business_id)).size;
  const onCall = board.businesses.find((b) => b.status === "on_call" || b.status === "ringing");
  switch (state) {
    case "paid":
      return { tone: "ok", words: "Paid" };
    case "confirmed":
      return { tone: "ok", words: "Order confirmed" };
    case "cancelled":
      return { tone: "idle", words: "Cancelled" };
    case "failed":
      return { tone: "risk", words: "Stopped" };
    case "paying":
      return { tone: "hold", words: board.purchase ? "Approved, finishing the purchase" : "Approved, ready to pay" };
  }
  if (board.open_questions.length) return { tone: "hold", words: board.open_questions.length === 1 ? "A business needs your answer" : `${board.open_questions.length} businesses need your answer` };
  if (state === "awaiting_approval") return { tone: "hold", words: board.ready ? "Quotes are final, ready for your approval" : "Ready for your approval" };
  if (onCall) return { tone: "live", words: onCall.status === "on_call" ? `On a call with ${onCall.name}` : `Calling ${onCall.name}` };
  if (state === "negotiating") return { tone: "live", words: "Negotiating for a better price" };
  if (state === "created" || state === "contacting") return { tone: "live", words: asking ? `Contacting ${plural(asking, "business", "businesses")}` : "Contacting businesses" };
  if (asking && quoted) return { tone: "live", words: `${quoted} of ${asking} quoted` };
  return { tone: "live", words: asking ? `Waiting for ${plural(asking, "reply", "replies")}` : stateWords(state) };
}

/** Money saved by negotiating: only when there is a real earlier price above the current total. */
export function savedBy(q: Pick<BoardQuote, "negotiated_from" | "total_usd">): number | null {
  if (q.negotiated_from === undefined || q.total_usd === null) return null;
  const saved = Math.round((q.negotiated_from - q.total_usd) * 100) / 100;
  return saved > 0 ? saved : null;
}

export interface MustHaves {
  /** The deal's must-haves. */
  total: number;
  /** How many this quote meets; null when the board doesn't say. */
  met: number | null;
  /** Must-haves it states it misses ("At least 12 vegetarian meals (only 6 of 12)"). */
  unmet: string[];
  /** Must-haves it didn't confirm. */
  unconfirmed: string[];
  /** Other reasons it can't win on its own (over budget, over the cap, no total). */
  other: string[];
}

const ISSUE_PREFIX = /^(doesn't meet|not confirmed):\s*/i;

/** Which must-haves a quote meets, from the board's compliance (else meets_requirements). Null when the deal has none. */
export function mustHaves(q: BoardQuote, board: Pick<DealBoardView, "job" | "compliance">): MustHaves | null {
  const total = board.job?.requirements.length ?? 0;
  const c = board.compliance?.[q.quote_id];
  const unmet: string[] = [];
  const unconfirmed: string[] = [];
  const other: string[] = [];
  for (const i of c?.issues ?? []) {
    const text = sentence(i.text.replace(ISSUE_PREFIX, ""));
    if (i.code === "requirement_unmet") unmet.push(text);
    else if (i.code === "requirement_unconfirmed") unconfirmed.push(text);
    else if (i.code !== "no_total") other.push(text);
  }
  if (!total && !other.length) return null;
  const met = c ? Math.max(0, total - unmet.length - unconfirmed.length) : q.meets_requirements ? total : null;
  return { total, met, unmet, unconfirmed, other };
}

export interface SheetRow {
  quote: BoardQuote;
  rank: QuoteRank;
  /** The human may choose it for approval now. */
  selectable: boolean;
}

/**
 * The quote sheet: current quotes that can still win, sorted by total (unknown totals last, the
 * server's order on ties); then the ones that can't win; then earlier versions of a quote.
 */
export function sheetQuotes(board: Pick<DealBoardView, "quotes" | "recommended_quote_id" | "quote_status" | "rejected" | "approval">): { rows: SheetRow[]; excluded: SheetRow[]; older: BoardQuote[] } {
  const all = board.quotes.map((quote, i) => ({ quote, rank: quoteRank(quote, board), i }));
  const total = (q: BoardQuote) => (q.total_usd === null ? Number.POSITIVE_INFINITY : q.total_usd);
  const row = ({ quote, rank }: { quote: BoardQuote; rank: QuoteRank }): SheetRow => ({
    quote,
    rank,
    selectable: isApprovable(quote, board) || (!!board.approval && board.approval.quote_id === quote.quote_id),
  });
  const live = all.filter((r) => r.rank === "recommended" || r.rank === "eligible" || r.rank === "other");
  live.sort((a, b) => total(a.quote) - total(b.quote) || a.i - b.i);
  return {
    rows: live.map(row),
    excluded: all.filter((r) => r.rank === "excluded").map(row),
    older: all.filter((r) => r.rank === "old").map((r) => r.quote),
  };
}

/** The approval bar's line: "$5 deposit now, $1,150 total" or "$1,150 now, no deposit stated". */
export function payNowLine(total: number, deposit: number | null | undefined): string {
  if (deposit !== null && deposit !== undefined && deposit > 0 && deposit < total) return `${money(deposit)} deposit now, ${money(total)} total`;
  return `${money(total)} now, the full total (no deposit stated)`;
}

export interface ActivityItem {
  business_id: string;
  business: string;
  channel: string;
  /** What happened, in the buyer's words ("Golden Grill quoted $1,380"). */
  text: string;
  /** The server's own one-line note on it, when it adds something. */
  detail?: string;
  at?: string;
  /** A call is ringing or in progress (the 3-bar indicator). */
  live: boolean;
  tone: Tone;
}

const SENT: Record<string, string> = { email: "Emailed", imessage: "Texted", phone: "Called", a2a: "Sent the request to" };

/** What Haggle did per business, newest first (undated last), from the board's businesses, quotes and counteroffers. */
export function activity(board: Pick<DealBoardView, "businesses" | "quotes" | "negotiation" | "open_questions">): ActivityItem[] {
  const items = board.businesses.map((b, i): ActivityItem & { i: number } => {
    const q = currentQuoteOf(board, b.id);
    const counter = [...(board.negotiation ?? [])].reverse().find((n) => n.business_id === b.id);
    const basis = counter ? board.quotes.find((x) => x.quote_id === counter.basis_quote_id) : undefined;
    const asked = board.open_questions.some((x) => x.business_id === b.id);
    const name = b.name;
    let text: string;
    let tone: Tone = "idle";
    let live = false;
    let own = false; // the text already says what the server's note would
    if (b.status === "on_call") {
      text = `On the call with ${name} now`;
      tone = "live";
      live = true;
    } else if (b.status === "ringing") {
      text = `Calling ${name}`;
      tone = "live";
      live = true;
    } else if (asked) {
      text = `${name} asked a question`;
      tone = "hold";
    } else if (b.status === "negotiating" && counter) {
      text = counter.outcome_total_usd !== null
        ? `${name} answered the counteroffer with ${money(counter.outcome_total_usd)}`
        : `Countered ${name} with ${basis && basis.business_id !== b.id ? `${possessive(basis.business)} ` : ""}${money(counter.target_total_usd)}`;
      tone = "live";
      own = true;
    } else if ((b.status === "quoted" || b.status === "won" || b.status === "negotiating") && q && q.total_usd !== null) {
      const saved = savedBy(q);
      text = saved !== null && q.negotiated_from !== undefined ? `${name} came down from ${money(q.negotiated_from)} to ${money(q.total_usd)}` : `${name} quoted ${money(q.total_usd)}`;
      tone = b.status === "won" ? "ok" : "idle";
    } else if (b.status === "declined") {
      text = `${name} declined`;
      tone = "risk";
    } else if (b.status === "no_reply") {
      text = `No reply from ${name} yet`;
      tone = "hold";
    } else if (b.status === "unavailable") {
      text = `Can't reach ${name} right now`;
      tone = "hold";
    } else {
      text = `${SENT[b.channel] ?? "Contacted"} ${name}`;
    }
    const note = b.unavailable_reason ?? b.last_event;
    const scheduled = counter?.scheduled_for && counter.outcome_total_usd === null ? `Callback scheduled for ${stamp(counter.scheduled_for)}` : undefined;
    const detail = scheduled ?? (!own && note && note.trim() ? plainNote(note) : undefined);
    return { business_id: b.id, business: name, channel: b.channel, text, ...(detail && detail !== text ? { detail } : {}), ...(b.last_event_at ? { at: b.last_event_at } : {}), live, tone, i };
  });
  const t = (x: { at?: string }) => (x.at ? Date.parse(x.at) || 0 : -1);
  return items.sort((a, b) => t(b) - t(a) || a.i - b.i).map(({ i: _i, ...rest }) => rest);
}

export interface ProgressStep {
  key: string;
  label: string;
  status: StepStatus;
}

/** The side column's progress, honest counts from the board: contacted, quoted, negotiated (if it ran), approval, payment. */
export function progress(board: Pick<DealBoardView, "job" | "businesses" | "quotes" | "negotiation" | "approval" | "payment" | "purchase">): ProgressStep[] {
  const state = board.job?.state ?? "created";
  const n = board.businesses.length;
  const quoted = new Set(board.quotes.filter((q) => q.total_usd !== null).map((q) => q.business_id)).size;
  const stopped = state === "cancelled" || state === "failed";
  const order = ["created", "contacting", "collecting", "negotiating", "awaiting_approval", "paying", "paid"];
  const at = state === "confirmed" ? order.length - 1 : order.indexOf(state);
  // A stopped deal keeps what really happened (contacted, quoted, countered) as done.
  const past = (s: string) => stopped || at > order.indexOf(s);
  const status = (done: boolean, current: boolean): StepStatus => (done ? "done" : current && !stopped ? "current" : "todo");
  const steps: ProgressStep[] = [
    { key: "contact", label: n ? `Contacted ${plural(n, "business", "businesses")}` : "Contact businesses", status: status(n > 0 && past("contacting"), state === "created" || state === "contacting") },
    { key: "quotes", label: n && quoted ? `${quoted} of ${n} quoted` : "Collect quotes", status: status(quoted > 0 && past("collecting"), state === "collecting") },
  ];
  const countered = new Set((board.negotiation ?? []).map((x) => x.business_id)).size;
  if (countered || state === "negotiating") {
    steps.push({ key: "negotiate", label: countered ? `Asked ${plural(countered, "business", "businesses")} for a better price` : "Negotiate", status: status(countered > 0 && past("negotiating"), state === "negotiating") });
  }
  const approved = !!board.approval && ["approved", "used"].includes(board.approval.status);
  steps.push({ key: "approve", label: approved ? "You approved a quote" : "Your approval", status: status(approved || (!stopped && past("awaiting_approval")), state === "awaiting_approval") });
  const finish = state === "confirmed" ? "Order confirmed" : state === "paid" ? (board.payment?.simulated ? "Paid (simulated)" : "Paid") : board.purchase ? "Purchase" : "Payment";
  steps.push({ key: "finish", label: finish, status: status(state === "paid" || state === "confirmed", state === "paying") });
  if (stopped) steps.push({ key: "stopped", label: state === "cancelled" ? "Cancelled" : "Stopped", status: "current" });
  return steps;
}

/** "2026-11-05" -> "Thu, Nov 5" (a calendar date, read in UTC so it never shifts a day); other text unchanged. */
export function dayWords(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const t = Date.parse(`${date}T12:00:00Z`);
  if (Number.isNaN(t)) return date;
  return new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** A /deals row's counts: "6 contacted, 3 quoted" (parts the server left out are skipped). */
export function dealCounts(d: Pick<DealRow, "businesses" | "quotes">): string {
  const parts = [d.businesses !== undefined ? `${d.businesses} contacted` : null, d.quotes !== undefined ? `${d.quotes} quoted` : null];
  return parts.filter(Boolean).join(", ");
}
