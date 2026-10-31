// PURE: is this price plausible for what was asked?
//
// "I gave a $50 quote for dinner for 100 people and it happily approved it" (product owner,
// 2026-10-30). A good buyer notices a price far outside the normal range, doesn't recommend it, asks
// the business once to confirm the total and what it includes, and warns the client. This module
// decides from data only (the brain's price range, else a conservative per-person floor for food);
// categories with neither go to a short Claude judgment (parsing/priceJudgment.ts), and its answer
// is turned into the same shape here. The engine stores the judgment on the quote record and sets:
//   price_implausible        far below the usual range: not recommended, never cited in a
//                            counteroffer, not approvable until the business confirms it
//   price_confirmed_unusual  the business confirmed that low price: approvable, with a caveat
//   price_unusually_high     far above the usual range: a caveat only
import { HEDGE, ownWords } from "./approximate.ts";

export const IMPLAUSIBLE_FLAG = "price_implausible";
export const CONFIRMED_UNUSUAL_FLAG = "price_confirmed_unusual";
export const UNUSUALLY_HIGH_FLAG = "price_unusually_high";
export const PRICE_FLAGS: ReadonlySet<string> = new Set([IMPLAUSIBLE_FLAG, CONFIRMED_UNUSUAL_FLAG, UNUSUALLY_HIGH_FLAG]);

/** A judged price, stored on the quote record (`price_judgment`). Money in cents, for the order total judged. */
export interface PriceJudgment {
  verdict: "plausible" | "too_low" | "too_high";
  /** price_data: the brain's learned quotes or baseline; category_floor: the table below; claude: a model judgment. */
  basis: "price_data" | "category_floor" | "claude";
  /** The total this judgment is about; a different total is judged again. */
  total_cents: number;
  quantity?: number;
  /** Singular unit word for "each" phrasing, e.g. "person". */
  unit?: string;
  /** The usual range for this whole order, when known. */
  expected_low_cents?: number;
  expected_high_cents?: number;
  /** Short plain-words reason (≤ 200 chars). */
  reason: string;
  /** The business confirmed this exact total when asked (too_low only). */
  confirmed?: true;
}

/** Under this share of the usual range's low end is too low (the brain's TOO_LOW_SHARE, mirrored). */
export const TOO_LOW_SHARE = 0.4;
/** Over this multiple of the usual range's high end is unusually high (a caveat, never a block). */
export const TOO_HIGH_MULTIPLE = 3;

/**
 * Conservative per-person floors where no price data exists: below the floor no real business sells
 * this (a few dollars a head for a catered meal). Deliberately low and narrow: pizza, desserts or
 * coffee can be cheap, so they aren't here; Claude judges what the table doesn't cover.
 */
const CATEGORY_FLOORS: { match: RegExp; unit: string; floor_usd: number; usual_usd: [number, number]; ceiling_usd: number }[] = [
  {
    match: /\b(cater(?:ing|er|ed)?|dinners?|lunch(?:es|eon)?|brunch|buffets?|banquets?|meals?|bbq|barbecue|plated|reception food)\b/i,
    unit: "person", floor_usd: 3, usual_usd: [12, 60], ceiling_usd: 400,
  },
];
const PEOPLE_UNITS = /^(people|persons?|guests?|heads?|attendees?|pax|ppl|covers?|diners?|employees?|staff)$/i;

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { maximumFractionDigits: cents % 100 === 0 ? 0 : 2, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 })}`;
const roundDollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export interface JudgeInput {
  totalCents: number;
  /** Quantity the order is for (request quantity, else the quoted headcount). */
  quantity: number | null;
  /** The request's unit ("people" when absent). */
  unit?: string | undefined;
  /** The request's own words ("dinner for our offsite"). */
  what: string;
  /** The brain's price check for this total (engine PriceVerdict), when it had data. */
  brain?: { verdict: string; typical_low_usd?: number | undefined; typical_high_usd?: number | undefined } | null;
}

function words(input: { totalCents: number; quantity: number | null; unit: string | undefined }): string {
  const each = input.quantity && input.quantity > 1 ? ` (${dollars(Math.round(input.totalCents / input.quantity))} per ${input.unit ?? "unit"})` : "";
  return `${dollars(input.totalCents)}${input.quantity ? ` for ${input.quantity.toLocaleString("en-US")}` : ""}${each}`;
}

function judged(verdict: PriceJudgment["verdict"], basis: PriceJudgment["basis"], input: JudgeInput, unit: string | undefined, low: number | undefined, high: number | undefined): PriceJudgment {
  const range = low !== undefined && high !== undefined ? `${roundDollars(low)}–${roundDollars(high)}` : null;
  const what = words({ totalCents: input.totalCents, quantity: input.quantity, unit });
  const reason = verdict === "too_low" ? `${what} is far below the usual${range ? ` ${range}` : " price"} for this order`
    : verdict === "too_high" ? `${what} is far above the usual${range ? ` ${range}` : " price"} for this order`
    : `${what} is within the usual range${range ? ` (${range})` : ""}`;
  return {
    verdict, basis, total_cents: input.totalCents, reason: clip(reason, 200),
    ...(input.quantity ? { quantity: input.quantity } : {}), ...(unit ? { unit } : {}),
    ...(low !== undefined ? { expected_low_cents: low } : {}), ...(high !== undefined ? { expected_high_cents: high } : {}),
  };
}

/**
 * The deterministic judgment, or null when there is no basis (no price data, no floor for this
 * category): the engine may then ask Claude. The brain's price data wins; the category floor still
 * catches a price no business could charge when the brain's data says nothing.
 */
export function judgeDeterministic(input: JudgeInput): PriceJudgment | null {
  if (!(input.totalCents > 0)) return null;
  const qty = input.quantity && input.quantity > 0 ? input.quantity : null;
  const peopleUnit = !input.unit || PEOPLE_UNITS.test(input.unit.trim());
  const floor = qty && peopleUnit ? CATEGORY_FLOORS.find((f) => f.match.test(input.what)) : undefined;
  const unit = floor?.unit ?? (peopleUnit ? "person" : input.unit?.replace(/s$/i, ""));
  const b = input.brain;
  const brainLow = b?.typical_low_usd !== undefined ? Math.round(b.typical_low_usd * 100) : undefined;
  const brainHigh = b?.typical_high_usd !== undefined ? Math.round(b.typical_high_usd * 100) : undefined;
  const known = b && b.verdict !== "unknown";
  if (known && b!.verdict === "too_low") return judged("too_low", "price_data", input, unit, brainLow, brainHigh);
  if (known && brainHigh !== undefined && input.totalCents > brainHigh * TOO_HIGH_MULTIPLE) return judged("too_high", "price_data", input, unit, brainLow, brainHigh);
  if (floor && qty) {
    const perUnitCents = input.totalCents / qty;
    const low = brainLow ?? floor.usual_usd[0] * 100 * qty;
    const high = brainHigh ?? floor.usual_usd[1] * 100 * qty;
    if (perUnitCents < floor.floor_usd * 100) return judged("too_low", "category_floor", input, unit, low, high);
    if (!known && perUnitCents > floor.ceiling_usd * 100) return judged("too_high", "category_floor", input, unit, low, high);
    if (!known) return judged("plausible", "category_floor", input, unit, low, high);
  }
  if (known) return judged("plausible", "price_data", input, unit, brainLow, brainHigh);
  return null;
}

/** Claude's answer (parsing/priceJudgment.ts), as a stored judgment. */
export function fromClaudeJudgment(input: JudgeInput, r: { plausible: boolean; expected_range_usd: { low: number; high: number } | null; reason: string }): PriceJudgment {
  const low = r.expected_range_usd && r.expected_range_usd.low > 0 ? Math.round(r.expected_range_usd.low * 100) : undefined;
  const high = r.expected_range_usd && r.expected_range_usd.high >= r.expected_range_usd.low ? Math.round(r.expected_range_usd.high * 100) : undefined;
  const peopleUnit = !input.unit || PEOPLE_UNITS.test(input.unit.trim());
  const unit = peopleUnit ? "person" : input.unit?.replace(/s$/i, "");
  // Only "far above" when Claude's own range says so; an implausible price with no range is treated as too low (it blocks until confirmed).
  const verdict = r.plausible ? "plausible" : high !== undefined && input.totalCents > high ? "too_high" : "too_low";
  const base = judged(verdict, "claude", input, unit, low, high);
  const said = r.reason.replace(/https?:\/\/\S+|www\.\S+/gi, "").replace(/\s+/g, " ").trim();
  return { ...base, ...(said && verdict !== "plausible" ? { reason: clip(`${base.reason}: ${said}`, 200) } : {}) };
}

/** Flags for a judgment (the caller strips PRICE_FLAGS first). */
export function priceFlags(j: PriceJudgment | undefined): string[] {
  if (!j) return [];
  if (j.verdict === "too_low") return [j.confirmed ? CONFIRMED_UNUSUAL_FLAG : IMPLAUSIBLE_FLAG];
  return j.verdict === "too_high" ? [UNUSUALLY_HIGH_FLAG] : [];
}

/** A price Haggle doubts: never recommended or cited to other businesses (confirmed or not). */
export function priceDoubt(r: { flags: string[] } | null | undefined): boolean {
  return !!r && r.flags.some((f) => f === IMPLAUSIBLE_FLAG || f === CONFIRMED_UNUSUAL_FLAG);
}

/** The usual range in words ("the usual range of $1,200–$6,000"), or a generic phrase. */
function rangeWords(j: PriceJudgment | undefined): string {
  return j?.expected_low_cents !== undefined && j.expected_high_cents !== undefined ? `the usual range of ${roundDollars(j.expected_low_cents)}–${roundDollars(j.expected_high_cents)}` : "the usual price for this";
}

/** What the human is warned about on the board, the approval and the web deal page (null: nothing to say). */
export function priceCaveat(r: { flags: string[]; price_judgment?: PriceJudgment | undefined }): string | null {
  const j = r.price_judgment;
  if (r.flags.includes(CONFIRMED_UNUSUAL_FLAG)) return `Vendor confirmed this price, but it is far below ${rangeWords(j)}`;
  if (r.flags.includes(IMPLAUSIBLE_FLAG)) return `Suspiciously low: ${j?.reason ?? "far below the usual price for this order"}; not confirmed by the vendor yet`;
  if (r.flags.includes(UNUSUALLY_HIGH_FLAG)) return `Unusually high: ${j?.reason ?? "far above the usual price for this order"}`;
  return null;
}

/** Why the board can't offer Approve on a suspiciously low quote, and what lifts it. */
export function priceBlockReason(j: PriceJudgment | undefined, name: string, phone: boolean, asked: boolean): string {
  const why = j?.reason ? `Suspiciously low: ${j.reason}.` : "Suspiciously low for what was asked.";
  return phone ? `${why} Confirming it needs a callback to ${name}, which only you can authorize; it can't be approved until then.`
    : asked ? `${why} Haggle asked ${name} once to confirm the total and what it includes; it can be approved when they confirm.`
    : `${why} ${name} must confirm the total and what it includes before it can be approved.`;
}

/** The plain question Haggle asks the business, once: "is $50 the full total for dinner for 100 guests, and what does it include?" */
export function priceConfirmQuestion(input: { totalCents: number; what: string; quantity: number | null; unit?: string | undefined }): string {
  const what = clip(input.what.replace(/\s+/g, " ").trim(), 60);
  const qty = input.quantity ? ` for ${input.quantity.toLocaleString("en-US")}${input.unit ? ` ${input.unit}` : /\bfor \d/.test(what) ? "" : " guests"}` : "";
  const order = /\bfor \d/.test(what) ? what : `${what}${qty}`;
  return `is ${dollars(input.totalCents)} the full total for ${order}, and what does it include?`;
}

/**
 * The business's answer to that question confirms the price: an affirmation ("Yes", "That's
 * correct", "Yes, $50 is the full total") with no hedge and no correction ("sorry, typo: $5,000").
 * A restated different total is a correction, judged again by the caller.
 */
export function confirmsPrice(text: string, channel: string): boolean {
  const t = ownWords(text, channel).replace(/\s+/g, " ").trim();
  if (!t || HEDGE.test(t)) return false;
  if (/\b(no|nope|not|sorry|typo|mistake|wrong|actually|correction|meant|should have been|should be)\b/i.test(t)) return false;
  return /^(?:yes|yeah|yep|yup|correct|confirmed|right|exactly|indeed|that'?s (?:right|correct|it))\b/i.test(t)
    || /\b(?:is|that'?s|that is) (?:correct|right|accurate)\b|\bi confirm\b|\bconfirm(?:ed|ing)? (?:that|the|our)\b|\bis (?:the|our) (?:full|total|final|all[- ]in|whole)\b/i.test(t);
}
