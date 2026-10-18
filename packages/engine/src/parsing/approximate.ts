// PURE: is the business's total a firm figure, or an approximation in its own words?
//
// "prolly around 1300 total bucks" and "It'll cost approximately twelve hundred dollars" are real
// replies (2026-10-18 rehearsal). They are prices worth comparing, but not amounts anyone may approve
// or charge: Haggle marks them `approximate_total`, asks the business once for a firm all-in total,
// and never cites them as firm quotes. Decided here from the business's own text (deterministic, no
// schema field: Claude's structured-output grammar limit is already tight, see extraction.ts).
import { businessText, spokenAmounts } from "./callSafety.ts";

export const APPROXIMATE_FLAG = "approximate_total";

/** Hedge words that make a figure approximate when they are in the same clause as it. */
const HEDGE = /(~|≈|\b(?:around|about|approx(?:imately|imate)?|roughly|rough|prolly|probably|prob|maybe|perhaps|est|estimate[ds]?|estimated|ballpark(?:ing)?|should be|somewhere|circa|give or take|or so|close to|nearly|in the (?:range|neighbou?rhood|ballpark) of|i'?d (?:say|guess)|guess(?:ing|timate)?|ish)\b|\d\s*-\s*ish\b|\d\s*ish\b)/i;

/** A sentence that hedges the whole reply ("That's an estimate.", "ballpark", "subject to change"). */
const WHOLE_REPLY_HEDGE = /\b(?:(?:that'?s|this is|it'?s|just|only)\s+(?:a|an|just a|only a)?\s*(?:rough|ballpark|estimate|approximate|guess)|rough (?:estimate|number|figure|guess)|ballpark|give or take|subject to change|not (?:a )?firm|to be confirmed|tbc)\b/i;

/** The reply as the business wrote it: no quoted earlier mail; on a call, only the business's lines. */
export function ownWords(body: string, channel: string): string {
  if (channel === "phone") return businessText(body);
  const lines: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*On .{4,200}wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    lines.push(line);
  }
  return lines.join("\n");
}

/** Clauses: sentences, lines, and comma/semicolon parts (a thousands comma "1,300" never splits). */
function clauses(text: string): string[] {
  return text.split(/[\n;!?]+|\.(?=\s|$)|,(?=\s)|\s[-–—]\s|\bbut\b/i).map((c) => c.trim()).filter(Boolean);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Does this clause state `dollars` (as digits, "1.3k", or words like "twelve hundred")? */
function mentions(clause: string, dollars: number): boolean {
  const whole = Math.floor(dollars);
  const cents = Math.round((dollars - whole) * 100);
  for (const m of clause.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k\b)?/gi)) {
    const n = Number(m[1]!.replace(/,/g, "") + (m[2] ?? "")) * (m[3] ? 1000 : 1);
    if (Math.abs(n - dollars) < 0.005) return true;
  }
  return cents === 0 && spokenAmounts(clause).includes(whole);
}

/**
 * True when the business hedged its total in its own words. Every clause that states the total (or,
 * failing that, the clause holding the extraction's quoted excerpt) must be hedged; a total said
 * once firmly anywhere is firm. A sentence that hedges the whole reply ("That's a rough estimate")
 * makes it approximate too.
 */
export function isApproximateTotal(input: { totalCents: number | null; excerpts: string[]; text: string; channel: string }): boolean {
  if (input.totalCents === null) return false;
  const text = ownWords(input.text ?? "", input.channel);
  const parts = clauses(text);
  const dollars = input.totalCents / 100;
  let stated = parts.filter((c) => mentions(c, dollars));
  if (stated.length === 0) {
    // A computed or worded total: find the clause(s) holding the quoted excerpt(s).
    const ex = input.excerpts.map(norm).filter((e) => e.length >= 2);
    stated = parts.filter((c) => ex.some((e) => norm(c).includes(e) || (e.length >= 4 && e.includes(norm(c)) && /\d/.test(c))));
    if (stated.length === 0) return ex.some((e) => HEDGE.test(e)) || WHOLE_REPLY_HEDGE.test(text);
  }
  if (stated.every((c) => HEDGE.test(c))) return true;
  // A firm-looking figure in a reply that calls itself an estimate is still an estimate.
  return parts.some((c) => !/\d/.test(c) && WHOLE_REPLY_HEDGE.test(c));
}

/**
 * "Yes", "yep that's firm", "yes firm, $200 deposit": an answer that confirms the figure Haggle read
 * back. A bare affirmation, or one that names the firmness/total; "yes 40 veggie meals" answers
 * something else and confirms nothing about the price.
 */
export function confirmsFirm(text: string, channel: string): boolean {
  const t = ownWords(text, channel).trim();
  if (!t || HEDGE.test(t) || /\?/.test(t)) return false;
  const m = /^(?:yes|yeah|yep|yup|correct|confirmed|that'?s (?:right|correct|firm|it)|firm|it'?s firm|exactly|right)\b/i.exec(t);
  if (!m) return false;
  const rest = t.slice(m[0].length).replace(/[\s,.!:;-]+/g, " ").trim();
  return rest === "" || /\b(firm|final|exact|all[- ]?in|confirmed?|total|that'?s (?:right|correct|it))\b/i.test(rest);
}
