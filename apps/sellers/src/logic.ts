/**
 * What each persona says next, decided deterministically from the thread so far:
 * ask a question, quote, revise in negotiation, hold, or confirm.
 */
import type { Persona } from "./personas.ts";
import { withTerms, type Terms } from "./variation.ts";

export interface Rfq {
  quantity?: number;
  vegetarian?: number;
  date?: string;
}

export interface QuoteFacts {
  business: string;
  quantity: number;
  /** True when the buyer didn't say how many people (we priced a default). */
  assumedQuantity: boolean;
  vegetarianRequested?: number;
  vegetarianOffered: number;
  perHead: number;
  foodSubtotal: number;
  addOn?: { label: string; total: number };
  deliveryUsd: number;
  total: number;
  depositUsd?: number;
  depositPct?: number;
  items: string[];
  date?: string;
  round: number;
  negotiatedFrom?: number;
}

export type Plan =
  | { kind: "question"; question: string }
  | { kind: "quote"; facts: QuoteFacts; held: boolean }
  | { kind: "confirm"; facts: QuoteFacts };

export interface ThreadState {
  persona: string;
  stage: "asked" | "quoted" | "confirmed";
  rfq: Rfq;
  addOn: boolean;
  round: number;
  lastTotal?: number;
  /** This conversation's own terms (variation.ts); absent = the persona's base numbers. */
  terms?: Terms;
}

const DEFAULT_QUANTITY = 30;

// ---------------------------------------------------------------------------
// Reading the buyer's message

const QTY = /\b(\d{1,4})\s*-?\s*(?:people|persons?|guests?|attendees|ppl|pax|heads?|employees|folks|colleagues)\b/i;
const QTY_ALT = /\b(?:for|headcount:?|party of|group of)\s+(\d{1,4})\b(?!\s*(?:vegetarian|veggie|vegan|veg)\b)/i;
const VEG = /\b(\d{1,4})\s*\+?\s*(?:of them\s+)?(?:vegetarian|veggie|vegan|veg)\b/i;
const VEG_ALT = /\b(?:vegetarian|veggie|vegan)\b[^.\d]{0,30}?(\d{1,4})\b/i;
const DATE_ISO = /\b(20\d{2}-\d{2}-\d{2})\b/;
const DATE_WORDS = /\b((?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:mon|tue|wed|thu|fri|sat|sun)\b\.?)(?:,?\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}))?/i;

const int = (s: string | undefined) => (s === undefined ? undefined : Number.parseInt(s, 10));

/** Pull headcount, vegetarian count and date from an RFQ (structured JSON part first, then text). */
export function parseRfq(text: string, data?: unknown): Rfq {
  const out: Rfq = { ...rfqFromData(data) };
  out.quantity ??= int(text.match(QTY)?.[1]) ?? int(text.match(QTY_ALT)?.[1]);
  out.vegetarian ??= int(text.match(VEG)?.[1]) ?? int(text.match(VEG_ALT)?.[1]);
  if (!out.date) {
    const iso = text.match(DATE_ISO)?.[1];
    const words = text.match(DATE_WORDS);
    out.date = iso ?? (words ? [words[1], words[2]].filter(Boolean).join(" ") : undefined);
  }
  if (out.vegetarian !== undefined && out.quantity !== undefined && out.vegetarian > out.quantity) out.vegetarian = undefined;
  return compact(out);
}

function rfqFromData(data: unknown): Rfq {
  if (!data || typeof data !== "object") return {};
  const d = data as Record<string, unknown>;
  const q = d.quantity;
  const quantity =
    typeof q === "number" ? q : q && typeof q === "object" && typeof (q as { amount?: unknown }).amount === "number" ? (q as { amount: number }).amount : typeof d.headcount === "number" ? d.headcount : undefined;
  const vegetarian = typeof d.vegetarian === "number" ? d.vegetarian : undefined;
  const date = typeof d.date === "string" ? d.date : undefined;
  return compact({ quantity, vegetarian, date });
}

const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g;

export function detectCounter(text: string): { isCounter: boolean; citesCompetingQuote: boolean } {
  const hasAmount = [...text.matchAll(MONEY)].length > 0;
  const cites =
    /\b(another|other|competing|competitor|different)\b[^.]{0,60}\b(quote|quoted|offer|caterer|vendor|business|bid)\b/i.test(text) ||
    /\b(?:have|got|received)\s+(?:a\s+)?quote\b/i.test(text) ||
    /\bquoted (?:us|me)\b/i.test(text);
  const asks = /\b(lower|discount|better price|best price|match|beat|come down|reduce|counter|budget|target|sharpen)\b/i.test(text);
  return { isCounter: asks || cites, citesCompetingQuote: cites && hasAmount };
}

export function detectConfirm(text: string): boolean {
  // "not yet confirmed as firm" (Haggle's counter citing an estimate) is not a booking.
  const affirmative = text.replace(/(?:\bnot|n't|\bnever)\s+(?:yet\s+|been\s+)*(?:confirm|approv|accept)\w*/gi, "");
  return /\b(confirm(?:ed|ing)?|book it|go ahead|we'?re in|approved?|accept(?:ed)?|let'?s do it)\b/i.test(affirmative);
}

/** Haggle's note that the customer cancelled ("we won't be moving forward"). */
export function detectCancel(text: string): boolean {
  return /\b(cancel(?:l?ed|s)?\b|won'?t be moving forward|no longer need)/i.test(text);
}

/** Answer to "need plates?": explicit no wins; otherwise yes if they asked for them. */
export function wantsAddOn(text: string): boolean {
  if (/\b(no|nope|not needed|don'?t need|do not need|just the food|food only|we have our own)\b/i.test(text)) return false;
  return /\b(yes|yeah|yep|please|need|include|would be great|sure)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Pricing

const r2 = (n: number) => Math.round(n * 100) / 100;

export function computeQuote(p: Persona, rfq: Rfq, opts: { addOn: boolean; round: number; total?: number; negotiatedFrom?: number }): QuoteFacts {
  const quantity = rfq.quantity ?? DEFAULT_QUANTITY;
  const requested = rfq.vegetarian;
  const vegetarianOffered =
    p.vegetarianCap !== undefined ? Math.min(requested ?? p.vegetarianCap, p.vegetarianCap) : (requested ?? Math.ceil(quantity * 0.3));

  const foodSubtotal = r2(p.perHead * quantity);
  const addOn = opts.addOn && p.addOn ? { label: p.addOn.label, total: r2(p.addOn.perHead * quantity) } : undefined;
  let total = r2(foodSubtotal + (addOn?.total ?? 0) + p.deliveryUsd);
  if (p.minimumUsd !== undefined && total < p.minimumUsd) total = p.minimumUsd;
  if (opts.total !== undefined) total = opts.total;

  const items = [
    `${p.menu.slice(0, 2).join(" and ")} for ${quantity}`,
    `${vegetarianOffered} ${p.vegItem}`,
    p.deliveryUsd > 0 ? `Delivery $${p.deliveryUsd}` : "Delivery included",
    ...(addOn ? [capitalize(addOn.label)] : []),
  ];

  return compact({
    business: p.name,
    quantity,
    assumedQuantity: rfq.quantity === undefined,
    vegetarianRequested: requested,
    vegetarianOffered,
    perHead: r2(total / quantity),
    foodSubtotal,
    addOn,
    deliveryUsd: p.deliveryUsd,
    total,
    depositUsd: p.depositPct ? r2(total * p.depositPct) : undefined,
    depositPct: p.depositPct,
    items,
    date: rfq.date,
    round: opts.round,
    negotiatedFrom: opts.negotiatedFrom,
  });
}

// ---------------------------------------------------------------------------
// The decision

/**
 * `draw` gives a new conversation its own terms (variation.ts); without it the persona's base
 * numbers apply. Returns the persona as it behaves in this conversation, for the reply's words.
 */
export function planReply(
  base: Persona,
  state: ThreadState | undefined,
  text: string,
  data?: unknown,
  draw?: (p: Persona) => Terms,
): { plan: Plan; state: ThreadState; persona: Persona } {
  const terms = state ? state.terms : draw?.(base);
  const p = terms ? withTerms(base, terms) : base;
  return { ...decide(p, state, text, data, terms), persona: p };
}

function decide(p: Persona, state: ThreadState | undefined, text: string, data: unknown, terms: Terms | undefined): { plan: Plan; state: ThreadState } {
  if (!state) {
    const rfq = parseRfq(text, data);
    if (p.question) {
      return { plan: { kind: "question", question: p.question }, state: compact({ persona: p.key, stage: "asked" as const, rfq, addOn: false, round: 0, terms }) };
    }
    return quoteRound1(p, rfq, false, terms);
  }

  if (state.stage === "asked") {
    const rfq = { ...state.rfq, ...parseRfq(text, data) };
    return quoteRound1(p, rfq, wantsAddOn(text), state.terms);
  }

  const current = computeQuote(p, state.rfq, { addOn: state.addOn, round: state.round, total: state.lastTotal });

  if (state.stage === "confirmed" || detectConfirm(text)) {
    return { plan: { kind: "confirm", facts: current }, state: { ...state, stage: "confirmed" } };
  }

  const counter = detectCounter(text);
  const canDrop =
    counter.isCounter &&
    state.round < 2 &&
    p.negotiation.dropPct > 0 &&
    (!p.negotiation.needsCompetingQuote || counter.citesCompetingQuote);

  if (!canDrop || state.lastTotal === undefined) {
    return { plan: { kind: "quote", facts: current, held: counter.isCounter }, state };
  }

  const revised = Math.round(state.lastTotal * (1 - p.negotiation.dropPct));
  const facts = computeQuote(p, state.rfq, { addOn: state.addOn, round: 2, total: revised, negotiatedFrom: state.lastTotal });
  return { plan: { kind: "quote", facts, held: false }, state: { ...state, round: 2, lastTotal: revised } };
}

function quoteRound1(p: Persona, rfq: Rfq, addOn: boolean, terms: Terms | undefined): { plan: Plan; state: ThreadState } {
  const facts = computeQuote(p, rfq, { addOn, round: 1 });
  return {
    plan: { kind: "quote", facts, held: false },
    state: compact({ persona: p.key, stage: "quoted" as const, rfq, addOn, round: 1, lastTotal: facts.total, terms }),
  };
}

/** Structured quote for agent-ready businesses (A2A data part, quote.json email attachment). */
export function quoteJson(p: Persona, f: QuoteFacts, now: Date = new Date()) {
  const validUntil = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  return compact({
    protocol: "haggle.quote.v1",
    type: "quote",
    business: p.name,
    business_id: p.business_id,
    total_usd: f.total,
    per_unit_usd: f.perHead,
    quantity: f.quantity,
    unit: "people",
    vegetarian_meals: f.vegetarianOffered,
    deposit_usd: f.depositUsd,
    delivery_usd: f.deliveryUsd,
    delivery_included: f.deliveryUsd === 0,
    items: f.items,
    date: f.date,
    round: f.round,
    negotiated_from: f.negotiatedFrom,
    valid_until: validUntil,
  });
}

/** "$1,150" or "$1,035.50". */
export function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
