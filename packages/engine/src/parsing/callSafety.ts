// PURE: call-transcript safety and the money/number readers behind it. The ONE implementation
// (decision 24): parsing/heuristic.ts, workflow/callPolicy.ts and negotiation/messageGuard.ts
// re-export these. Union of main's callSafety.ts and feat/live-demo's heuristic.ts / callPolicy.ts /
// messageGuard.ts (both ported from haggle-testing).
//
// - A money figure (or tax rate) only Haggle's own voice agent said (e.g. a competing price it cited,
//   or the buyer's target) is never the business's, unless the business explicitly confirmed a
//   read-back. The business's figures count however they were said (digits or words).
// - A "completed" call that only reached a screener, voicemail or phone menu is not a quote.
import type { AskField } from "../contract.ts";
import type { QuoteExtraction } from "./extraction.ts";

/** Lines of a call transcript spoken by Haggle's own voice agent (never the business's figures). */
export function isAgentLine(line: string): boolean {
  return /^\s*(haggle\b|local\s*:|agent\s*:|assistant\s*:|ai assistant\b)/i.test(line);
}

/**
 * Only the business's side of a call transcript (speaker labels removed). The default channel is
 * "phone" (a transcript); any other channel's text passes through unchanged.
 */
export function businessText(body: string, channel: string = "phone"): string {
  if (channel !== "phone") return body;
  return body.split("\n").filter((l) => l.trim() && !isAgentLine(l)).map((l) => l.replace(/^[^:]{1,60}:\s*/, "")).join("\n");
}

/** Dollar amounts in free text, as cents: "$1,250.50", "$ 40", "$4.5k", "40 dollars", "40.5 USD". */
export function findDollarAmounts(text: string): number[] {
  const out: number[] = [];
  const toCents = (s: string, k = false) => Math.round(Number(s.replace(/,/g, "")) * (k ? 1000 : 1) * 100);
  const num = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
  for (const m of text.matchAll(new RegExp(String.raw`\$\s?${num}(\s*k\b)?`, "gi"))) out.push(toCents(m[1]!, m[2] !== undefined));
  for (const m of text.matchAll(new RegExp(String.raw`${num}\s*(?:us\s*)?(?:dollars?|usd)\b`, "gi"))) out.push(toCents(m[1]!));
  return out;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/**
 * Numbers a person said in words, as speech-to-text writes them ("Seventeen dollars", "a hundred",
 * "two fifty bucks", "one thousand eighty", "six thousand"), in dollars. Each run of number words
 * yields its standard value, its parts, and the spoken-price reading ("two fifty" = 250, "eleven
 * fifty" = 1150).
 */
export function spokenAmounts(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const isNum = (w: string | undefined, next?: string) =>
    w !== undefined && (w in UNITS || w in TENS || w === "hundred" || w === "thousand" || (w === "a" && (next === "hundred" || next === "thousand")));
  const out = new Set<number>();
  let i = 0;
  while (i < words.length) {
    if (!isNum(words[i], words[i + 1])) { i++; continue; }
    // One run: number words, "and" between them, "a" before hundred/thousand.
    const run: string[] = [];
    while (i < words.length && (isNum(words[i], words[i + 1]) || (words[i] === "and" && run.length > 0 && isNum(words[i + 1], words[i + 2])))) {
      if (words[i] !== "and") run.push(words[i] === "a" ? "one" : words[i]!);
      i++;
    }
    // Segments below 100 ("twenty five" = 25) between the hundred/thousand markers.
    const segments: number[] = [];
    let total = 0;
    let current = 0;
    let seg: number | null = null;
    const closeSeg = () => { if (seg !== null) { segments.push(seg); current += seg; seg = null; } };
    for (const w of run) {
      if (w in UNITS) {
        // "twenty five" continues a segment; "two fifty" / "seventeen five" start a new one.
        if (seg !== null && !(seg >= 20 && seg % 10 === 0 && UNITS[w]! < 10)) closeSeg();
        seg = (seg ?? 0) + UNITS[w]!;
      } else if (w in TENS) {
        closeSeg();
        seg = TENS[w]!;
      } else if (w === "hundred") {
        closeSeg();
        current = (current || 1) * 100;
      } else {
        closeSeg();
        total += (current || 1) * 1000;
        current = 0;
      }
    }
    closeSeg();
    const multiplied = run.includes("hundred") || run.includes("thousand");
    if (multiplied) out.add(total + current);
    for (const s of segments) out.add(s);
    // "two fifty", "eleven fifty": a price said as two pairs of digits.
    if (!multiplied && segments.length === 2 && segments[0]! >= 1 && segments[1]! >= 10) out.add(segments[0]! * 100 + segments[1]!);
  }
  return [...out];
}

/** Percentages said in a text, in digits ("8%", "8 percent") or words ("ten percent"). */
export function percentsIn(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|per\s?cent)/gi)) out.add(Number(m[1]));
  for (const m of text.matchAll(/((?:[a-z-]+[\s,]+){1,3})per\s?cent/gi)) for (const n of spokenAmounts(m[1]!)) out.add(n);
  return [...out];
}

/** Every amount in a text, as cents: dollar figures plus numbers said in words. */
function amountsCents(text: string): number[] {
  return [...findDollarAmounts(text), ...spokenAmounts(text).map((d) => d * 100)];
}

const CONFIRM_REQUEST = /\b(to confirm|confirming|is that (?:right|correct)|that right\?|sounds? (?:right|good)\?|correct\?)/i;
const AFFIRM = /^\s*(?:[^:]{1,60}:\s*)?(?:yes|yeah|yep|yup|correct|right|that'?s (?:right|correct)|exactly|sounds (?:right|good)|mhm|uh-huh|perfect)\b/i;

/** The text of each agent read-back that asked for confirmation and that the business's very next line affirmed. */
function confirmedReadBackTexts(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!isAgentLine(lines[i]!)) { i++; continue; }
    const block: string[] = [];
    while (i < lines.length && (isAgentLine(lines[i]!) || !lines[i]!.trim())) block.push(lines[i++]!);
    const reply = lines[i];
    const text = block.join(" ").replace(/\s+/g, " ");
    if (reply !== undefined && CONFIRM_REQUEST.test(text) && AFFIRM.test(reply)) out.push(text);
  }
  return out;
}

/**
 * Call-transcript safety net: a money figure that only Haggle's own voice agent said (digits or
 * words) is never the business's price. Such values are nulled and listed as missing, in the
 * catering fields and in money ask answers (`ask`). The business's figures count however they were
 * said, and so does a read-back the business explicitly confirmed ("Just to confirm, $858 all in.
 * Is that right?" -> "Yes"). The same holds for a tax rate.
 */
export function dropAgentOnlyAmounts(x: QuoteExtraction, transcript: string, ask: AskField[] = []): QuoteExtraction {
  const lines = transcript.split("\n");
  const agentText = lines.filter(isAgentLine).join("\n");
  const businessLines = lines.filter((l) => !isAgentLine(l)).join("\n");
  const readBacks = confirmedReadBackTexts(lines);
  // A tax rate only the agent said ("is that with 8 percent tax?") is not the business's rate either.
  const rate = x.tax_rate_percent ?? null;
  if (rate !== null) {
    const agentRates = new Set(percentsIn(agentText));
    const businessRates = new Set([...percentsIn(businessLines), ...readBacks.flatMap(percentsIn)]);
    if (agentRates.has(rate) && !businessRates.has(rate)) x = { ...x, tax_rate_percent: null };
  }
  const agent = new Set(amountsCents(agentText));
  if (agent.size === 0) return x;
  const business = new Set(amountsCents(businessLines));
  for (const n of businessLines.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []) business.add(Math.round(Number(n.replace(/,/g, "")) * 100));
  for (const cents of readBacks.flatMap(amountsCents)) business.add(cents);
  const agentOnly = (cents: number) => agent.has(cents) && !business.has(cents);
  const out: QuoteExtraction = { ...x, missing_fields: [...x.missing_fields], sources: [...x.sources] };
  const fields = [["total", "total_usd"], ["deposit", "deposit_usd"], ["subtotal", "subtotal_usd"], ["price_per_head", "price_per_head_usd"], ["delivery_fee", "delivery_fee_usd"], ["tax", "tax_usd"]] as const;
  for (const [field, key] of fields) {
    const v = out[key];
    if (v === null || !agentOnly(Math.round(v * 100))) continue;
    out[key] = null;
    out.missing_fields.push(field);
    out.sources = out.sources.filter((s) => s.field !== field);
  }
  if (out.answers) {
    const money = new Set(ask.filter((f) => f.type === "money").map((f) => f.key));
    out.answers = out.answers.map((a) => {
      if (!money.has(a.key) || a.value === null) return a;
      const cents = findDollarAmounts(a.value.includes("$") ? a.value : `$${a.value}`)[0];
      return cents !== undefined && agentOnly(cents) ? { ...a, value: null, source: "", excerpt: "" } : a;
    });
  }
  return out;
}

const SCREENER = /(please (?:state|say) your name|the person you(?:'re| are) calling|record your name|reason for (?:your )?call|is not available|leave (?:a|your) message|voice ?mail|after the (?:tone|beep)|mailbox is full|press \d|google voice|call screen)/i;

/**
 * Did a completed call reach a person who said something? Call screeners, voicemail greetings and
 * phone menus produce "completed" calls with no answers: those are "reached, no answer", never an
 * (empty) quote.
 */
export function answeredSomething(transcript: string): boolean {
  const real = businessText(transcript, "phone").split("\n").map((l) => l.trim()).filter((l) => l && !SCREENER.test(l));
  return real.join(" ").split(/\s+/).filter(Boolean).length >= 4;
}
