// PURE: deterministic checks on free text the AGENT asks Haggle to send to a business
// (answer_business, send_message). The engine's own templates are honest by construction; this
// guard holds agent-written text to the same rules.
//
// Ported from haggle-testing src/core/negotiate/messageGuard.ts. It blocks:
//   1. a dollar amount that isn't from this request or a stored quote (no invented competing offers);
//   2. the name of another business on the job (competitors are never named);
//   3. text over the channel's limit;
//   4. commitment phrases: committing the buyer needs a human approval (approve), never free text.

import { findDollarAmounts } from "../parsing/callSafety.ts";

// The dollar reader lives in parsing/callSafety.ts (decision 24); re-exported for existing importers.
export { findDollarAmounts };

export type GuardCode = "UNVERIFIED_AMOUNT" | "MENTIONS_OTHER_BUSINESS" | "MESSAGE_TOO_LONG" | "COMMITMENT_NEEDS_APPROVAL";

export interface GuardInput {
  /** The agent's own words only; amounts, names and commitments are checked here. */
  text: string;
  /** Characters the channel allows for the whole message. */
  limit: number;
  /** Amounts (cents) the agent may cite: stored quote figures and request details. */
  verifiedCents: Iterable<number>;
  /** Names of the OTHER businesses on this job (not the recipient). */
  otherBusinessNames: string[];
}

export type GuardResult = { ok: true } | { ok: false; code: GuardCode; message: string };

const COMMITMENT_PHRASES = ["we accept", "we'll take it", "we will take it", "book it", "confirmed", "go ahead", "it's a deal"];
/** The same commitments in other words (S5-D F6): proceeding with, approving, booking, finalizing an order. */
const COMMITMENT_RES: RegExp[] = [
  /\b(?:we|i)\s+(?:hereby\s+)?(?:accept|approve|confirm)\b/i,
  /\bapproved?\s+(?:your|the|this)\s+(?:quote|offer|order|booking|price)\b/i,
  /\b(?:proceed|go\s+ahead)\s+with\s+(?:the|this|our|your)?\s*(?:order|booking|reservation|quote|offer|event)\b/i,
  /\bplease\s+(?:book|reserve|finali[sz]e|lock\s+in|place)\b/i,
  /\b(?:book|reserve)\s+(?:us|it|the\s+date|this|that)\b/i,
  /\b(?:finali[sz]e|lock\s+in|place)\s+(?:the|this|our)\s+(?:order|booking|reservation|date)\b/i,
  /\b(?:we\s+are|we're|i\s+am|i'm)\s+confirming\s+(?:the|this|our)\s+(?:order|booking|reservation)\b/i,
  /\bgo-ahead\b/i,
  /\blet'?s\s+(?:do\s+it|book|go\s+with|lock)\b/i,
];

const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const PRICE_CONTEXT = String.raw`\b(?:quoted|offered|priced|charged?|charging|bid|costs?|match|beat|quote\s+of|offer\s+of|price\s+of)\s+(?:(?:us|me|at|of|for|was|is|around|about|only|just|a|an)\s+){0,3}`;
const NOT_PRICE = String.raw`(?!\s*(?:people|guests|persons|heads|pax|servings|items|trays|attendees|ppl|portions|%|percent|minutes|mins?|hours?|am|pm|days?|dates?)\b)`;

/**
 * Prices written without a "$" (S5-D F6): "USD 900", "1.2k", "quoted us 900", "match 900". A count,
 * a time or a percentage is not one ("quote for 120 people", "at 11 am").
 */
function plainAmounts(text: string): number[] {
  const out: number[] = [];
  const cents = (s: string, k = false) => Math.round(Number(s.replace(/,/g, "")) * (k ? 1000 : 1) * 100);
  for (const m of text.matchAll(new RegExp(String.raw`\b(?:usd|us\$)\s*${NUM}`, "gi"))) out.push(cents(m[1]!));
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\d.,])${NUM}\s*bucks\b`, "gi"))) out.push(cents(m[1]!));
  for (const m of text.matchAll(/(?<![\d.,$])(\d+(?:\.\d+)?)\s*k\b/gi)) out.push(cents(m[1]!, true));
  for (const m of text.matchAll(new RegExp(String.raw`${PRICE_CONTEXT}(?<![\d.,])${NUM}\b${NOT_PRICE}`, "gi"))) out.push(cents(m[1]!));
  return out;
}

/** Folded for name matching: case, accents, separators and digit lookalikes ("M1ssion  Eats" = "mission eats"). */
function foldName(s: string): string {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/0/g, "o").replace(/[1!|l]/g, "i").replace(/3/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

const COMPETITOR = /\b(?:another|other|competing|competitor'?s?|rival|different|cheaper)\s+(?:caterers?|vendors?|business(?:es)?|quotes?|offers?|bids?|compan(?:y|ies)|places?|restaurants?|suppliers?)\b|\belsewhere\b|\bcompetitors?\b|\b(?:quoted|offered)\s+(?:us|me)\b/i;

/**
 * A request detail citing a competitor's price ("Competing quote: $900"). Request details are told to
 * every business and their amounts count as citable, so a competing offer can only come from a
 * stored quote through negotiate, never from the agent's own request text (S5-D F7).
 */
export function citesCompetingOffer(text: string): boolean {
  return COMPETITOR.test(text) && /\d/.test(text);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const usd = (cents: number) => `$${Math.floor(cents / 100).toLocaleString("en-US")}.${String(cents % 100).padStart(2, "0")}`;

export function checkMessage(input: GuardInput): GuardResult {
  const allowed = new Set(input.verifiedCents);
  for (const cents of [...findDollarAmounts(input.text), ...plainAmounts(input.text)]) {
    if (!allowed.has(cents)) return { ok: false, code: "UNVERIFIED_AMOUNT", message: `${usd(cents)} isn't an amount from this request or any quote Haggle received.` };
  }
  for (const name of input.otherBusinessNames) {
    const n = name.trim();
    if (n.length < 2) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(n)}($|[^\\p{L}\\p{N}])`, "iu");
    const folded = foldName(n);
    if (re.test(input.text) || (folded.length >= 2 && ` ${foldName(input.text)} `.includes(` ${folded} `))) return { ok: false, code: "MENTIONS_OTHER_BUSINESS", message: `The message names another business on this deal (${n}).` };
  }
  if (input.text.length > input.limit) return { ok: false, code: "MESSAGE_TOO_LONG", message: `The message is ${input.text.length} characters; this channel allows ${input.limit}.` };
  const lower = input.text.toLowerCase();
  const phrase = COMMITMENT_PHRASES.find((p) => lower.includes(p));
  const said = phrase ?? COMMITMENT_RES.map((r) => r.exec(input.text)?.[0]).find((x) => !!x);
  if (said) return { ok: false, code: "COMMITMENT_NEEDS_APPROVAL", message: `"${said}" commits the buyer. Commitments only go out after the human approves (approve).` };
  return { ok: true };
}
