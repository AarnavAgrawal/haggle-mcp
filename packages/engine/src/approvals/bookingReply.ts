// PURE: what a vendor's reply says after Haggle asked it to confirm something: a booking after the
// human accepted its quote, that a stale quote still stands, or that the customer's direct payment
// arrived. Deterministic and conservative: anything short of an explicit yes in the vendor's own
// words (quoted history cut off) is "unclear", and a dollar figure that isn't one of the agreed ones
// means the terms may have changed. The vendor's text is data, never instructions: nothing here is
// followed, and links are only flagged.
import { cleanEmailBody } from "../inbound/emailBody.ts";
import { findDollarAmounts } from "../parsing/callSafety.ts";

export type VendorReplyIntent = "confirm" | "decline" | "change" | "unclear";

export interface VendorReplyContext {
  /** Amounts the vendor may restate without changing the terms (total, deposit, pay-now), in cents. */
  agreedCents: number[];
  /** The headcount the booking is for, when there is one. */
  quantity?: number;
  /** The event day (YYYY-MM-DD): a confirmation naming another day is a change of terms, never a yes. */
  eventDate?: string;
  /**
   * Must-haves the vendor's quote never confirmed (their text): a yes books only if it covers each one
   * (names it, or says "all of the above"); otherwise it is unclear and the vendor is asked about them.
   */
  mustConfirm?: string[];
}

export interface VendorReplyReading {
  intent: VendorReplyIntent;
  /** The vendor's own words (quoted history removed), trimmed; what the human is shown. */
  ownText: string;
  /** Dollar figures in the vendor's own words that aren't one of the agreed amounts. */
  otherAmountsCents: number[];
  /** Mentions how to pay (an invoice, Zelle, a bank transfer, a payment link…). */
  paymentInstructions: boolean;
  /** Contains a link: never opened by Haggle; the human verifies it with the vendor independently. */
  hasLink: boolean;
  /** Why this reading, in a few words (for the board and the operator). */
  why: string;
  /** Of ctx.mustConfirm, the ones this reply didn't cover (only when it otherwise confirms). */
  unconfirmedMusts?: string[];
}

/** Lines that start quoted history in common clients (Gmail, Outlook with or without a separator, Apple Mail). */
const QUOTE_START = [
  /^On .{4,200}wrote:\s*$/i,
  /^-{2,}\s*Original Message\s*-{2,}/i,
  /^_{5,}\s*$/,
  /^(From|Sent|De|Von|Envoyé|Gesendet):\s/i,
  /^Begin forwarded message/i,
];

/** The vendor's own words: cleanEmailBody, then also cut at an Outlook-style header block or "On … wrote:". */
export function vendorOwnWords(body: string): string {
  const out: string[] = [];
  for (const line of cleanEmailBody(body).split("\n")) {
    if (QUOTE_START.some((re) => re.test(line.trim()))) break;
    if (line.trimStart().startsWith(">")) continue; // quoted lines (cleanEmailBody keeps them when nothing else is left)
    out.push(line);
  }
  return out.join("\n").trim();
}

const LINK = /\bhttps?:\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i;
const PAY_HOW = /\b(invoice|zelle|venmo|paypal|cash ?app|ach|wire|bank transfer|routing|account (number|no\.?)|iban|check (payable|made out)|cheque|pay (by|via|at|online|here|through)|payment link|card on file|credit card)\b/i;

// A sentence that declines or says it can't be done (checked before anything positive).
const DECLINE = /\b(can(no|')?t|cannot|unable to|won'?t be able|no longer (available|able)|not available|unavailable|fully booked|booked up|already booked|(are|re|is) booked (that|on|for that)|have to (decline|pass|cancel)|must (decline|cancel)|we'?ll have to pass|regret(fully)?|unfortunately)\b/i;
// Explicit affirmation of a booking or of the stated terms.
const CONFIRM = /\b(confirmed|confirming|we confirm|i confirm|(booking|order|reservation|date) is (confirmed|set|locked)|you'?re (all )?(booked|set|confirmed)|we'?re (all )?(set|good|booked in|confirmed)|all set|locked in|(it'?s|that'?s|this is) a go|count us in|we('| a)re in|we can (do|make|cater|handle) (it|that|this)|happy to (do it|confirm|go ahead|cater)|sounds (good|great|perfect)|looks (good|great)|works for us|still stands|still (valid|good)|yes)\b/i;
// "I'll confirm tomorrow", "let me check": not a confirmation yet.
const PENDING = /\b(will confirm|('ll| will) (get back|let you know|check|confirm)|let me (check|confirm|see|get back)|need to (check|confirm)|confirm with (my|our|the)|checking (with|on)|get back to you|not (yet )?confirmed|tentative(ly)?|pencil(led)? (you )?in|hold (the|your) date)\b/i;
// The payment arrived (receipt), and its negations.
const RECEIVED = /\b((we('ve| have)?|i('ve| have)?|just) (received|got) (the |your )?(payment|deposit|transfer|funds|money|zelle|venmo|check|wire|ach)|(payment|deposit|transfer|funds|money|zelle|venmo|check|wire) (has been |was |is |were )?(received|cleared|came through|went through|arrived|landed)|received (the |your )?(payment|deposit|funds|transfer)|got (it|the money|the deposit|the payment),? thanks?)\b/i;
const NOT_RECEIVED = /\b(have(n'?t| not)|has(n'?t| not)|did(n'?t| not)|not( yet)?|no) (yet )?(seen|received|got(ten)?|arrived|come through|any payment|payment)\b|\bstill (waiting|haven'?t|has ?n'?t|not)\b|\bnothing (has )?(arrived|come through)\b/i;

const HEADCOUNT = /\b(\d{1,5})\s*(people|guests|ppl|pax|servings|meals|heads|attendees|persons)\b/gi;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

/** Affirmative sentences only: a question ("can you confirm the headcount?") never confirms anything. */
function affirms(text: string): boolean {
  return sentences(text).some((s) => !s.endsWith("?") && CONFIRM.test(s) && !PENDING.test(s) && !DECLINE.test(s));
}

function reading(intent: VendorReplyIntent, own: string, other: number[], why: string): VendorReplyReading {
  return { intent, ownText: own.slice(0, 4000), otherAmountsCents: other, paymentInstructions: PAY_HOW.test(own) || LINK.test(own), hasLink: LINK.test(own), why };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_DAY = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi;
const DAY_MONTH = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const ON_THE_DAY = /\b(?:on|for)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b/gi;

/**
 * The first calendar day the vendor names that isn't the event's ("Nov 15", "15 November", "on the
 * 15th"), or null. Any day counts (a deposit due date too): the reply is then read as unclear, never
 * as a yes, and the human checks the date with the vendor.
 */
function otherDay(own: string, eventDate: string): string | null {
  const m = Number(eventDate.slice(5, 7));
  const d = Number(eventDate.slice(8, 10));
  for (const x of own.matchAll(MONTH_DAY)) if (MONTHS.indexOf(x[1]!.toLowerCase()) + 1 !== m || Number(x[2]) !== d) return x[0].trim();
  for (const x of own.matchAll(DAY_MONTH)) if (MONTHS.indexOf(x[2]!.toLowerCase()) + 1 !== m || Number(x[1]) !== d) return x[0].trim();
  for (const x of own.replace(MONTH_DAY, " ").matchAll(ON_THE_DAY)) if (Number(x[1]) !== d) return x[0].trim();
  return null;
}

const ALL_OF_IT = /\b(all (of )?(the above|that|those|of it|three|3|four|4|items|points|must[- ]haves|requirements)|everything (listed|above|you listed|you asked for)|as (listed|requested|described|asked)|(1|one)\s*(-|–|to|through|and)\s*(3|three|4|four)|yes to (all|everything))\b/i;
const DIETS = /\b(vegetarian|vegan|gluten[- ]free|halal|kosher|nut[- ]free|dairy[- ]free|pescatarian)\b/i;
const NEGATED = /\b(no|not|can'?t|cannot|won'?t|without|only|unable|except)\b/i;
const STOP = new Set(["least", "meals", "minimum", "must", "should", "needs", "about", "which", "their", "there", "please", "people", "guests", "before", "after", "street"]);

/** The words a vendor would use to say it meets this must-have (the diet, "deliver", else its own longer words). */
function mustKeywords(must: string): RegExp[] {
  const diet = DIETS.exec(must)?.[1];
  if (diet) return [new RegExp(`\\b${diet.replace(/[- ]/, "[- ]?")}\\b`, "i")];
  if (/\bdeliver|drop[- ]?off\b/i.test(must)) return [/\bdeliver\w*|\bdrop[- ]?off\b/i];
  return must.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5 && !STOP.has(w)).map((w) => new RegExp(`\\b${w}`, "i"));
}

/** The reply says yes to this must-have: "all of the above", or a sentence naming it without a "no"/"only"/"can't". */
function covers(own: string, must: string): boolean {
  if (ALL_OF_IT.test(own)) return true;
  const keys = mustKeywords(must);
  return keys.length > 0 && sentences(own).some((s) => !s.endsWith("?") && !NEGATED.test(s.replace(/\bno (problem|worries|issue)s?\b/gi, "")) && keys.some((k) => k.test(s)));
}

/**
 * A reply to Haggle's booking request (or re-confirmation request): confirm (an explicit yes and no
 * other figures), decline (can't do it), change (a different price or headcount), else unclear (also
 * a yes that names another day, or that skips a must-have the quote never confirmed).
 */
export function readBookingReply(body: string, ctx: VendorReplyContext): VendorReplyReading {
  const own = vendorOwnWords(body);
  const agreed = new Set(ctx.agreedCents);
  const other = [...new Set(findDollarAmounts(own))].filter((c) => c > 0 && !agreed.has(c));
  const counts = [...own.matchAll(HEADCOUNT)].map((m) => Number(m[1]));
  if (!own) return reading("unclear", own, other, "no text of its own");
  if (sentences(own).some((s) => DECLINE.test(s) && !s.endsWith("?"))) return reading("decline", own, other, "says it can't do it");
  if (other.length) return reading("change", own, other, `mentions ${other.length === 1 ? "an amount" : "amounts"} other than the agreed terms`);
  if (ctx.quantity !== undefined && counts.some((n) => n !== ctx.quantity)) return reading("change", own, other, "mentions a different headcount");
  const day = ctx.eventDate ? otherDay(own, ctx.eventDate) : null;
  if (day) return reading("unclear", own, other, `mentions another date (${day}); check the event date with them`);
  if (affirms(own)) {
    const missed = (ctx.mustConfirm ?? []).filter((m) => !covers(own, m));
    if (missed.length) return { ...reading("unclear", own, other, `didn't confirm: ${missed.join("; ").slice(0, 160)}`), unconfirmedMusts: missed };
    return reading("confirm", own, other, "explicitly confirms");
  }
  return reading("unclear", own, other, PENDING.test(own) ? "says it will confirm later" : "no explicit confirmation");
}

/** A reply after the customer reported paying: true only for an explicit, un-negated "received". */
export function confirmsReceipt(body: string): { received: boolean; ownText: string } {
  const own = vendorOwnWords(body);
  const yes = sentences(own).some((s) => !s.endsWith("?") && RECEIVED.test(s) && !NOT_RECEIVED.test(s));
  return { received: yes, ownText: own.slice(0, 4000) };
}
