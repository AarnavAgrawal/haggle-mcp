// The workspace ledger: every deal with its quotes, open questions, approval, payment and event log,
// from one service read (GET /internal/workspaces/ledger, apps/mcp/src/service/ledger.ts), and the pure
// logic the admin pages (/dashboard, /deals, /quotes, /history) build on. No I/O; tested in
// tests/ledger.test.ts. Business text (names, question text, items) is untrusted data: plain text only.
import { dealGroupOf, dealStatus, type DealGroupKey } from "../../components/shell/deals.ts";
import type { StatusTone } from "../../components/ui/Status.tsx";
import { channelWords, flagWords, money as moneyWords, mustHaves, priceCheckWords, sentence, sheetQuotes, stamp } from "./format.ts";
import type { BoardQuote, DealBoardView, Mode } from "./types.ts";

export interface LedgerQuote {
  quote_id: string;
  business_id: string;
  business: string;
  channel: string;
  round: number;
  /** current, or an earlier/void version: superseded, expired, withdrawn. */
  status: string;
  /** A total the business never stated is null (unknown, never $0). */
  total_usd: number | null;
  per_unit_usd?: number;
  deposit_usd?: number;
  /** A real earlier total this quote came down from. */
  negotiated_from?: number;
  price_check?: string;
  meets_requirements: boolean;
  flags: string[];
  items: string[];
  valid_until?: string;
  confidence: number;
  source: string;
  received_at: string;
}

export interface LedgerBusiness {
  id: string;
  name: string;
  channel: string;
  status: string;
}

export interface LedgerQuestion {
  question_id: string;
  business_id: string;
  business: string;
  text: string;
  asked_at: string;
}

export interface LedgerApproval {
  quote_id: string;
  business_id: string;
  status: string;
  amount_usd: number;
  total_usd: number;
  channel: string;
  decided_at: string | null;
}

export interface LedgerPayment {
  status: string;
  amount_usd: number;
  simulated: boolean;
  at: string;
}

export type EventGroup = "status" | "contact" | "quote" | "negotiation" | "approval" | "payment" | "problem";

/** One line of a deal's history, already in the buyer's words (never message bodies or internal ids). */
export interface LedgerEvent {
  seq: number;
  at: string;
  group: EventGroup;
  business_id?: string;
  business?: string;
  text: string;
}

export interface LedgerDeal {
  job_id: string;
  what: string;
  quantity?: number;
  unit?: string;
  date?: string;
  area?: string;
  state: string;
  ready: boolean;
  created_at: string;
  updated_at: string;
  budget_usd: number | null;
  limit_usd: number | null;
  recommended_quote_id: string | null;
  businesses: LedgerBusiness[];
  quotes: LedgerQuote[];
  /** Pending questions only. */
  questions: LedgerQuestion[];
  approval: LedgerApproval | null;
  payment: LedgerPayment | null;
  purchase?: { stage: string };
  /** Newest first, capped per deal by the server. */
  events: LedgerEvent[];
}

export interface Ledger {
  ok: true;
  mode: Mode;
  deals: LedgerDeal[];
  /** More deals exist than were returned: every count on the page covers only these. */
  truncated: boolean;
  next: string;
}

const TERMINAL = new Set(["paid", "confirmed", "cancelled", "failed"]);
const STOPPED = new Set(["cancelled", "failed"]);
const APPROVED = new Set(["approved", "used"]);

export const isOpen = (d: Pick<LedgerDeal, "state">) => !TERMINAL.has(d.state);

/** Flags that say a quote may not be what it looks like: never the lead by default, always named in red. */
const ALARM_FLAGS = new Set(["external_payment_link", "prompt_injection", "unverified_sender", "conflicting_numbers", "price_implausible"]);
const hasAlarm = (q: { flags: string[] }) => q.flags.some((f) => ALARM_FLAGS.has(f));

/** Quotes still in play: the current version from each business, with a stated total. */
export const currentQuotes = (d: Pick<LedgerDeal, "quotes">) => d.quotes.filter((q) => q.status === "current");
export const pricedQuotes = (d: Pick<LedgerDeal, "quotes">) => currentQuotes(d).filter((q): q is LedgerQuote & { total_usd: number } => q.total_usd !== null);

/**
 * Where a deal belongs. Unlike the rail's state-only grouping, an open deal with a business's question
 * waiting is "needs you": the deal can't move until the buyer answers.
 */
export function ledgerGroup(d: Pick<LedgerDeal, "state" | "questions">): DealGroupKey {
  if (isOpen(d) && d.questions.length) return "needs_you";
  return dealGroupOf(d.state);
}

/** The status line of a deal row. */
export function ledgerStatus(d: Pick<LedgerDeal, "state" | "questions" | "businesses" | "quotes" | "purchase">): { tone: StatusTone; words: string } {
  if (isOpen(d) && d.questions.length) return { tone: "hold", words: d.questions.length === 1 ? "A business asked you something" : `${d.questions.length} questions for you` };
  if (d.state === "paying") return { tone: "hold", words: d.purchase && d.purchase.stage !== "paying" ? sentence(d.purchase.stage.replace(/_/g, " ")) : "Approved, finish the purchase" };
  return dealStatus({ state: d.state, businesses: d.businesses.length, quotes: new Set(pricedQuotes(d).map((q) => q.business_id)).size });
}

type LeadDeal = Pick<LedgerDeal, "state" | "quotes" | "recommended_quote_id" | "approval">;

/** The quote someone actually chose: the human's approval, else Haggle's recommendation. None on a stopped deal. */
function pickedId(d: LeadDeal): string | null {
  if (STOPPED.has(d.state)) return null;
  return d.approval && APPROVED.has(d.approval.status) ? d.approval.quote_id : d.recommended_quote_id;
}

/**
 * The quote a deal's row shows: the chosen one, else the lowest total that meets the must-haves and
 * carries no alarm (a suspicious quote is often the cheapest and must never read as the lead). A stopped
 * deal has none.
 */
export function leadQuote(d: LeadDeal): LedgerQuote | null {
  if (STOPPED.has(d.state)) return null;
  const id = pickedId(d);
  const picked = id ? d.quotes.find((q) => q.quote_id === id && q.total_usd !== null) : undefined;
  return picked ?? pricedQuotes(d).filter((q) => q.meets_requirements && !hasAlarm(q)).sort((a, b) => a.total_usd - b.total_usd)[0] ?? null;
}

/** Money taken off the lead quote by negotiating; only a real earlier price counts. */
export function savedOn(d: LeadDeal): number {
  const q = leadQuote(d);
  if (!q || q.total_usd === null || q.negotiated_from === undefined) return 0;
  return Math.max(0, Math.round((q.negotiated_from - q.total_usd) * 100) / 100);
}

export interface SpreadMark {
  quote_id: string;
  business: string;
  total_usd: number;
  /** 0 to 1 along the strip. */
  at: number;
  /** The approved or recommended quote: the only one the pen circles. */
  picked: boolean;
}
export interface Spread {
  marks: SpreadMark[];
  low: number;
  high: number;
  /** Where the budget sits on the strip (0 to 1), when the deal has one. */
  budgetAt: number | null;
  budget: number | null;
  /** One sentence for screen readers and the tooltip. */
  words: string;
}

/**
 * The quote spread: every current stated total on one strip, scaled from the lowest to the highest
 * value (the budget counts, so it stays on the strip). Null without a priced quote: a strip with
 * nothing on it says nothing.
 */
export function quoteSpread(d: LeadDeal & Pick<LedgerDeal, "budget_usd">, money: (n: number) => string): Spread | null {
  const priced = pricedQuotes(d);
  if (!priced.length) return null;
  const totals = priced.map((q) => q.total_usd);
  const low = Math.min(...totals);
  const high = Math.max(...totals);
  const budget = d.budget_usd;
  const min = budget !== null ? Math.min(low, budget) : low;
  const max = budget !== null ? Math.max(high, budget) : high;
  const at = (n: number) => (max === min ? 0.5 : (n - min) / (max - min));
  const picked = pickedId(d);
  const range = low === high ? `${priced.length === 1 ? "1 quote" : `${priced.length} quotes`} at ${money(low)}` : `${priced.length} quotes from ${money(low)} to ${money(high)}`;
  return {
    marks: priced.map((q) => ({ quote_id: q.quote_id, business: q.business, total_usd: q.total_usd, at: at(q.total_usd), picked: q.quote_id === picked })),
    low,
    high,
    budget,
    budgetAt: budget !== null ? at(budget) : null,
    words: budget !== null ? `${range}, budget ${money(budget)}` : range,
  };
}

export interface Totals {
  needsYou: number;
  inProgress: number;
  done: number;
  /** Current quotes with a stated total, on open deals. */
  quotes: number;
  /** Totals of the quotes the human approved, on deals that weren't stopped. */
  approvedUsd: number;
  /** Money taken off by negotiating, on the quotes the deals stand on. Stopped deals don't count. */
  savedUsd: number;
}

export function totals(deals: LedgerDeal[]): Totals {
  const t: Totals = { needsYou: 0, inProgress: 0, done: 0, quotes: 0, approvedUsd: 0, savedUsd: 0 };
  for (const d of deals) {
    const g = ledgerGroup(d);
    if (g === "needs_you") t.needsYou += 1;
    else if (g === "in_progress") t.inProgress += 1;
    else t.done += 1;
    if (isOpen(d)) t.quotes += pricedQuotes(d).length;
    if (STOPPED.has(d.state)) continue;
    if (d.approval && APPROVED.has(d.approval.status)) t.approvedUsd += d.approval.total_usd;
    t.savedUsd += savedOn(d);
  }
  return { ...t, approvedUsd: Math.round(t.approvedUsd * 100) / 100, savedUsd: Math.round(t.savedUsd * 100) / 100 };
}

export const STAGES = [
  { key: "contacting", label: "Contacting", states: ["created", "contacting"] },
  { key: "collecting", label: "Collecting quotes", states: ["collecting"] },
  { key: "negotiating", label: "Negotiating", states: ["negotiating"] },
  { key: "approval", label: "Your approval", states: ["awaiting_approval"] },
  { key: "paying", label: "Finishing purchase", states: ["paying"] },
  { key: "finished", label: "Paid or confirmed", states: ["paid", "confirmed"] },
  { key: "stopped", label: "Stopped", states: ["cancelled", "failed"] },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];

export const stageOf = (state: string): StageKey => STAGES.find((s) => (s.states as readonly string[]).includes(state))?.key ?? "collecting";

/** How many deals sit at each stage, in order; every stage is kept, so the shape doesn't jump. */
export function pipeline(deals: Pick<LedgerDeal, "state">[]): { key: StageKey; label: string; count: number }[] {
  return STAGES.map((s) => ({ key: s.key, label: s.label, count: deals.filter((d) => stageOf(d.state) === s.key).length }));
}

export type Attention =
  | { kind: "question"; id: string; deal: LedgerDeal; question: LedgerQuestion }
  | { kind: "approve"; id: string; deal: LedgerDeal; quote: LedgerQuote | null }
  | { kind: "purchase"; id: string; deal: LedgerDeal };

/** What only the human can move, most blocking first: questions (oldest first), approvals, purchases. */
export function attention(deals: LedgerDeal[]): Attention[] {
  const open = deals.filter(isOpen);
  const questions = open
    .flatMap((deal) => deal.questions.map((question): Attention & { at: string } => ({ kind: "question", id: question.question_id, deal, question, at: question.asked_at })))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ at: _at, ...item }) => item as Attention);
  // A pending approval names one exact quote: show that one, even if a better quote has arrived since.
  const asked = (d: LedgerDeal) => (d.approval?.status === "pending" ? d.quotes.find((q) => q.quote_id === d.approval!.quote_id) : undefined);
  const approvals = open.filter((d) => d.state === "awaiting_approval").map((deal): Attention => ({ kind: "approve", id: `approve-${deal.job_id}`, deal, quote: asked(deal) ?? leadQuote(deal) }));
  const purchases = open.filter((d) => d.state === "paying").map((deal): Attention => ({ kind: "purchase", id: `purchase-${deal.job_id}`, deal }));
  return [...questions, ...approvals, ...purchases];
}

export type DealView = "all" | DealGroupKey;
export type DealSortKey = "updated" | "started" | "what" | "quotes" | "best";
export type SortDir = "asc" | "desc";

export const dealViews = (deals: LedgerDeal[]): { key: DealView; label: string; count: number }[] => {
  const n = (k: DealGroupKey) => deals.filter((d) => ledgerGroup(d) === k).length;
  return [
    { key: "all", label: "All", count: deals.length },
    { key: "needs_you", label: "Needs you", count: n("needs_you") },
    { key: "in_progress", label: "In progress", count: n("in_progress") },
    { key: "done", label: "Done", count: n("done") },
  ];
};

const matches = (q: string, ...fields: (string | undefined)[]) => {
  const needle = q.trim().toLowerCase();
  return !needle || fields.some((f) => f?.toLowerCase().includes(needle));
};

/** The deals a view, a stage and a search leave. The search reads the request, the place and every business. */
export function filterDeals(deals: LedgerDeal[], f: { view?: DealView; stage?: string; q?: string }): LedgerDeal[] {
  return deals.filter(
    (d) =>
      (!f.view || f.view === "all" || ledgerGroup(d) === f.view) &&
      (!f.stage || stageOf(d.state) === f.stage) &&
      matches(f.q ?? "", d.what, d.area, ...d.businesses.map((b) => b.name)),
  );
}

/** Sorted copy; a deal without a value (no quote yet) goes last in either direction. */
export function sortDeals(deals: LedgerDeal[], key: DealSortKey, dir: SortDir): LedgerDeal[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (d: LedgerDeal): string | number | null => {
    switch (key) {
      case "what":
        return d.what.toLowerCase();
      case "quotes":
        return pricedQuotes(d).length;
      case "best":
        return leadQuote(d)?.total_usd ?? null;
      case "started":
        return d.created_at;
      case "updated":
        return d.updated_at;
    }
  };
  return [...deals].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

export type QuoteStanding = "approved" | "recommended" | "open" | "closed" | "replaced";

export interface QuoteRowItem extends LedgerQuote {
  job_id: string;
  deal: string;
  deal_state: string;
  budget_usd: number | null;
  standing: QuoteStanding;
}

const STANDING_WORDS: Record<QuoteStanding, string> = { approved: "You approved it", recommended: "Recommended", open: "In the running", closed: "Deal closed", replaced: "Replaced" };
export const standingWords = (s: QuoteStanding) => STANDING_WORDS[s];

/**
 * What to know before approving a quote still in play, by name: red only for an alarm, over budget is a
 * caution, and the other flags stay in the row's details. Null once a quote is out of play.
 */
export function quoteWarning(q: Pick<QuoteRowItem, "flags" | "standing">): { tone: "risk" | "hold"; words: string } | null {
  if (q.standing === "replaced" || q.standing === "closed") return null;
  const alarm = q.flags.find((f) => ALARM_FLAGS.has(f));
  if (alarm) return { tone: "risk", words: sentence(flagWords(alarm)) };
  return q.flags.includes("over_budget") ? { tone: "hold", words: "Over budget" } : null;
}

/** Every quote in the workspace, newest first, with where it stands on its deal. */
export function quoteRows(deals: LedgerDeal[]): QuoteRowItem[] {
  return deals
    .flatMap((d) =>
      d.quotes.map((q): QuoteRowItem => {
        const approved = !!d.approval && APPROVED.has(d.approval.status) && d.approval.quote_id === q.quote_id;
        const standing: QuoteStanding = q.status !== "current" ? "replaced" : approved && !STOPPED.has(d.state) ? "approved" : !isOpen(d) ? "closed" : q.quote_id === d.recommended_quote_id ? "recommended" : "open";
        return { ...q, job_id: d.job_id, deal: d.what, deal_state: d.state, budget_usd: d.budget_usd, standing };
      }),
    )
    .sort((a, b) => b.received_at.localeCompare(a.received_at));
}

export type QuoteView = "current" | "picks" | "replaced" | "all";
export type QuoteSortKey = "received" | "business" | "deal" | "total";

const inPlay = (r: QuoteRowItem) => r.standing !== "replaced" && r.standing !== "closed";

export const quoteViews = (rows: QuoteRowItem[]): { key: QuoteView; label: string; count: number }[] => [
  { key: "current", label: "In play", count: rows.filter(inPlay).length },
  { key: "picks", label: "Picks", count: rows.filter((r) => r.standing === "approved" || r.standing === "recommended").length },
  { key: "replaced", label: "Replaced", count: rows.filter((r) => r.standing === "replaced").length },
  { key: "all", label: "All", count: rows.length },
];

export function filterQuotes(rows: QuoteRowItem[], f: { view?: QuoteView; channel?: string; deal?: string; q?: string }): QuoteRowItem[] {
  return rows.filter(
    (r) =>
      (!f.view || f.view === "all" || (f.view === "current" ? inPlay(r) : f.view === "replaced" ? r.standing === "replaced" : r.standing === "approved" || r.standing === "recommended")) &&
      (!f.channel || r.channel === f.channel) &&
      (!f.deal || r.job_id === f.deal) &&
      matches(f.q ?? "", r.business, r.deal),
  );
}

export function sortQuotes(rows: QuoteRowItem[], key: QuoteSortKey, dir: SortDir): QuoteRowItem[] {
  const sign = dir === "asc" ? 1 : -1;
  const value = (r: QuoteRowItem): string | number | null => (key === "total" ? r.total_usd : key === "business" ? r.business.toLowerCase() : key === "deal" ? r.deal.toLowerCase() : r.received_at);
  return [...rows].sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    return (x < y ? -1 : x > y ? 1 : 0) * sign;
  });
}

export interface HistoryItem extends LedgerEvent {
  key: string;
  job_id: string;
  deal: string;
}

const ARRIVAL = /^(Email|Text|Reply|Message) from /;
const SAME_MOMENT_MS = 5_000;

/** "Email from X" says nothing the next line doesn't when that message was X's quote. */
function isQuoteArrival(e: LedgerEvent, events: LedgerEvent[]): boolean {
  if (e.group !== "contact" || !e.business_id || !ARRIVAL.test(e.text)) return false;
  const at = Date.parse(e.at);
  return events.some((x) => x.group === "quote" && x.business_id === e.business_id && Math.abs(Date.parse(x.at) - at) <= SAME_MOMENT_MS);
}

/** Every deal's events on one timeline, newest first. */
export function historyRows(deals: LedgerDeal[]): HistoryItem[] {
  return deals
    .flatMap((d) => d.events.filter((e) => !isQuoteArrival(e, d.events)).map((e): HistoryItem => ({ ...e, key: `${d.job_id}-${e.seq}`, job_id: d.job_id, deal: d.what })))
    .sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
}

export const HISTORY_GROUPS: { key: EventGroup; label: string }[] = [
  { key: "contact", label: "Contact" },
  { key: "quote", label: "Quotes" },
  { key: "negotiation", label: "Negotiation" },
  { key: "approval", label: "Approvals" },
  { key: "payment", label: "Payments" },
  { key: "status", label: "Deal status" },
  { key: "problem", label: "Problems" },
];

export function filterHistory(rows: HistoryItem[], f: { group?: string; deal?: string; q?: string }): HistoryItem[] {
  return rows.filter((r) => (!f.group || r.group === f.group) && (!f.deal || r.job_id === f.deal) && matches(f.q ?? "", r.text, r.deal, r.business));
}

/** "Today", "Yesterday", else "Mon, Nov 2", in UTC like every stamp on these pages. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const day = iso.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (day === today) return "Today";
  if (day === yesterday) return "Yesterday";
  const t = Date.parse(`${day}T12:00:00Z`);
  if (Number.isNaN(t)) return day;
  return new Date(t).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Consecutive items under their day, in the order given. */
export function byDay<T extends { at: string }>(rows: T[], now: Date = new Date()): { day: string; label: string; items: T[] }[] {
  const out: { day: string; label: string; items: T[] }[] = [];
  for (const r of rows) {
    const day = r.at.slice(0, 10);
    const last = out[out.length - 1];
    if (last?.day === day) last.items.push(r);
    else out.push({ day, label: dayLabel(r.at, now), items: [r] });
  }
  return out;
}

/**
 * One CSV cell. Business names and notes are untrusted, and a spreadsheet runs a cell that starts with
 * = + - @ (or a tab or return) as a formula: such text gets a leading apostrophe. Numbers stay numbers.
 */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv<T>(rows: T[], columns: { label: string; value: (row: T) => string | number | null | undefined }[]): string {
  const lines = [columns.map((c) => csvCell(c.label)).join(","), ...rows.map((r) => columns.map((c) => csvCell(c.value(r))).join(","))];
  return `${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------------------------------
// The tables' URLs: defaults, and reading a page's search params against an allow-list.

export const DEAL_DEFAULTS = { view: "all", stage: "", q: "", sort: "updated", dir: "desc" };
export const QUOTE_DEFAULTS = { view: "current", channel: "", deal: "", q: "", sort: "received", dir: "desc" };
export const HISTORY_DEFAULTS = { group: "", deal: "", q: "" };

export const DEAL_CHOICES = { view: ["all", "needs_you", "in_progress", "done"], stage: ["", ...STAGES.map((s) => s.key)], sort: ["updated", "started", "what", "quotes", "best"], dir: ["asc", "desc"] };
export const QUOTE_CHOICES = { view: ["current", "picks", "replaced", "all"], sort: ["received", "business", "deal", "total"], dir: ["asc", "desc"] };
export const HISTORY_CHOICES = { group: ["", ...HISTORY_GROUPS.map((g) => g.key)] };

/** A page's search params as a table query: unknown keys dropped, closed lists checked, the rest clipped. */
export function readQuery<T extends Record<string, string>>(params: Record<string, string | string[] | undefined>, defaults: T, choices: Partial<Record<keyof T, readonly string[]>> = {}): T {
  const out: Record<string, string> = { ...defaults };
  for (const key of Object.keys(defaults)) {
    const raw = params[key];
    const value = typeof raw === "string" ? raw.slice(0, 120) : undefined;
    if (value === undefined) continue;
    const allowed = (choices as Record<string, readonly string[] | undefined>)[key];
    if (!allowed || allowed.includes(value)) out[key] = value;
  }
  return out as T;
}

// ---------------------------------------------------------------------------------------------------
// One deal's board: the figures above the columns, and the side-by-side comparison.

type FigureBoard = Pick<DealBoardView, "quotes" | "businesses" | "recommended_quote_id" | "approval" | "job" | "request_details">;

const isCurrentPriced = (q: BoardQuote): q is BoardQuote & { total_usd: number } => q.total_usd !== null && (!q.status || q.status === "current");

export interface BoardFigures {
  lead: { business: string; total_usd: number } | null;
  budget: number | null;
  /** Lead minus budget: negative is under. Null without both. */
  againstBudget: number | null;
  /** Businesses with a stated total, of those asked. */
  quoted: number;
  asked: number;
  saved: number;
}

export function boardFigures(board: FigureBoard): BoardFigures {
  const priced = board.quotes.filter(isCurrentPriced);
  const approved = board.approval && APPROVED.has(board.approval.status) ? board.approval.quote_id : undefined;
  const byId = (id: string | null | undefined) => (id ? priced.find((q) => q.quote_id === id) : undefined);
  const safe = priced.filter((q) => q.meets_requirements && !q.flags.some((f) => ALARM_FLAGS.has(f)));
  const lead = STOPPED.has(board.job?.state ?? "") ? undefined : (byId(approved) ?? byId(board.recommended_quote_id) ?? [...safe].sort((a, b) => a.total_usd - b.total_usd)[0]);
  const budget = board.request_details?.budget_usd ?? board.job?.budget_usd ?? null;
  const from = lead?.negotiated_from;
  return {
    lead: lead ? { business: lead.business, total_usd: lead.total_usd } : null,
    budget,
    againstBudget: lead && budget !== null ? Math.round((lead.total_usd - budget) * 100) / 100 : null,
    quoted: new Set(priced.map((q) => q.business_id)).size,
    asked: board.businesses.length,
    saved: lead && from !== undefined ? Math.max(0, Math.round((from - lead.total_usd) * 100) / 100) : 0,
  };
}

export interface CompareCell {
  text: string;
  tone?: "best" | "miss" | "muted";
}
export interface CompareMatrix {
  columns: { quote_id: string; business: string; recommended: boolean; total_usd: number }[];
  rows: { label: string; cells: CompareCell[] }[];
}

const NOT_STATED: CompareCell = { text: "Not stated", tone: "muted" };
const MAX_COMPARED = 6;

/**
 * The quotes side by side: one column per quote still in the running (lowest total first, as on the
 * sheet), one row per fact any of them states. Null below two quotes: there is nothing to compare.
 */
export function compareMatrix(board: Parameters<typeof sheetQuotes>[0] & Pick<DealBoardView, "job" | "compliance" | "terms" | "request_details">): CompareMatrix | null {
  const quotes = sheetQuotes(board).rows.map((r) => r.quote).filter(isCurrentPriced).slice(0, MAX_COMPARED);
  if (quotes.length < 2) return null;
  const budget = board.request_details?.budget_usd ?? board.job?.budget_usd ?? null;
  // "Lowest" is praise: only a quote that meets the must-haves and carries no alarm can earn it.
  const honest = quotes.filter((q) => q.meets_requirements && !q.flags.some((f) => ALARM_FLAGS.has(f)));
  const lowest = honest.length ? Math.min(...honest.map((q) => q.total_usd)) : null;
  const onlyOneLowest = honest.filter((q) => q.total_usd === lowest).length === 1;
  const usd = (n: number | undefined | null): CompareCell => (n === undefined || n === null ? NOT_STATED : { text: moneyWords(n) });
  const terms = (q: BoardQuote) => board.terms?.[q.quote_id];
  const rows: CompareMatrix["rows"] = [
    { label: "Total", cells: quotes.map((q) => ({ text: moneyWords(q.total_usd), ...(onlyOneLowest && honest.includes(q) && q.total_usd === lowest ? { tone: "best" as const } : {}) })) },
  ];
  if (quotes.some((q) => q.flags.some((f) => ALARM_FLAGS.has(f)))) {
    rows.push({
      label: "Check first",
      cells: quotes.map((q) => {
        const alarm = q.flags.find((f) => ALARM_FLAGS.has(f));
        return alarm ? { text: sentence(flagWords(alarm)), tone: "miss" as const } : { text: "Nothing flagged", tone: "muted" as const };
      }),
    });
  }
  const add = (label: string, cell: (q: BoardQuote & { total_usd: number }) => CompareCell) => {
    const cells = quotes.map(cell);
    if (cells.some((c) => c !== NOT_STATED)) rows.push({ label, cells });
  };
  if (budget !== null) {
    add("Against budget", (q) => {
      const d = Math.round((q.total_usd - budget) * 100) / 100;
      return d > 0 ? { text: `${moneyWords(d)} over`, tone: "miss" } : { text: d === 0 ? "On budget" : `${moneyWords(-d)} under` };
    });
  }
  add("Each", (q) => usd(q.per_unit_usd));
  add("Deposit", (q) => usd(q.deposit_usd));
  add("Delivery", (q) => usd(q.delivery_usd));
  add("Tax", (q) => usd(q.tax_usd));
  add("Must-haves", (q) => {
    const m = mustHaves(q, board);
    if (!m?.total) return NOT_STATED;
    if (m.met === null) return { text: "Misses one", tone: "miss" };
    return { text: `${m.met} of ${m.total}`, ...(m.met < m.total ? { tone: "miss" as const } : {}) };
  });
  add("Price check", (q) => (q.price_check ? { text: priceCheckWords(q.price_check) } : NOT_STATED));
  add("Reached by", (q) => ({ text: channelWords(q.channel) }));
  add("Good until", (q) => (q.valid_until ? { text: stamp(q.valid_until) } : NOT_STATED));
  add("Cancellation", (q) => (terms(q)?.cancellation ? { text: terms(q)!.cancellation! } : NOT_STATED));
  add("Not included", (q) => (terms(q)?.exclusions?.length ? { text: terms(q)!.exclusions!.join("; ") } : NOT_STATED));
  return { columns: quotes.map((q) => ({ quote_id: q.quote_id, business: q.business, recommended: q.quote_id === board.recommended_quote_id, total_usd: q.total_usd })), rows };
}
