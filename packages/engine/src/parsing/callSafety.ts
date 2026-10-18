// PURE: call-transcript safety. Ported from Aarnav's feat/live-demo (heuristic.ts dropAgentOnlyAmounts /
// spokenAmounts, callPolicy.ts answeredSomething), trimmed to Haggle's current quote fields.
//
// - A money figure only Haggle's own voice agent said (e.g. a competing price it cited, or the buyer's
//   target) is never the business's price, unless the business explicitly confirmed a read-back.
// - A "completed" call that only reached a screener, voicemail or phone menu is not a quote.
import type { QuoteExtraction } from "./extraction.ts";

/** Lines spoken by Haggle's voice agent (never the business's figures). */
export function isAgentLine(line: string): boolean {
  return /^\s*(haggle\b|local\s*:|agent\s*:|assistant\s*:|ai assistant\b)/i.test(line);
}

/** Only the business's side of a call transcript. */
export function businessText(transcript: string): string {
  return transcript.split("\n").filter((l) => l.trim() && !isAgentLine(l)).map((l) => l.replace(/^[^:]{1,60}:\s*/, "")).join("\n");
}

/** "$1,080", "$4.5k", "$250.50" -> cents. */
export function findDollarAmounts(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?\s*(k\b)?/gi)) {
    const n = Number(m[1]!.replace(/,/g, "") + (m[2] ?? ""));
    if (Number.isFinite(n)) out.push(Math.round(n * (m[3] ? 1000 : 1) * 100));
  }
  return out;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

/** Dollar numbers said in words ("six thousand", "two fifty", "a hundred"), in dollars. */
export function spokenAmounts(text: string): number[] {
  const words = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const isNum = (w: string | undefined, next?: string) => w !== undefined && (w in UNITS || w in TENS || w === "hundred" || w === "thousand" || (w === "a" && (next === "hundred" || next === "thousand")));
  const out = new Set<number>();
  let i = 0;
  while (i < words.length) {
    if (!isNum(words[i], words[i + 1])) { i++; continue; }
    const run: string[] = [];
    while (i < words.length && (isNum(words[i], words[i + 1]) || (words[i] === "and" && run.length > 0 && isNum(words[i + 1], words[i + 2])))) {
      if (words[i] !== "and") run.push(words[i] === "a" ? "one" : words[i]!);
      i++;
    }
    const segments: number[] = [];
    let total = 0, current = 0;
    let seg: number | null = null;
    const closeSeg = () => { if (seg !== null) { segments.push(seg); current += seg; seg = null; } };
    for (const w of run) {
      if (w in UNITS) { if (seg !== null && !(seg >= 20 && seg % 10 === 0 && UNITS[w]! < 10)) closeSeg(); seg = (seg ?? 0) + UNITS[w]!; }
      else if (w in TENS) { closeSeg(); seg = TENS[w]!; }
      else if (w === "hundred") { closeSeg(); current = (current || 1) * 100; }
      else { closeSeg(); total += (current || 1) * 1000; current = 0; }
    }
    closeSeg();
    const multiplied = run.includes("hundred") || run.includes("thousand");
    if (multiplied) out.add(total + current);
    for (const s of segments) out.add(s);
    if (!multiplied && segments.length === 2 && segments[0]! >= 1 && segments[1]! >= 10) out.add(segments[0]! * 100 + segments[1]!);
  }
  return [...out];
}

const CONFIRM_REQUEST = /\b(to confirm|confirming|is that (?:right|correct)|that right\?|sounds? (?:right|good)\?|correct\?)/i;
const AFFIRM = /^\s*(?:[^:]{1,60}:\s*)?(?:yes|yeah|yep|yup|correct|right|that'?s (?:right|correct)|exactly|sounds (?:right|good)|mhm|uh-huh|perfect)\b/i;

/** Amounts in an agent read-back that asked for confirmation and that the business's next line affirmed. */
function confirmedReadBacks(lines: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; ) {
    if (!isAgentLine(lines[i]!)) { i++; continue; }
    const block: string[] = [];
    while (i < lines.length && (isAgentLine(lines[i]!) || !lines[i]!.trim())) block.push(lines[i++]!);
    const reply = lines[i];
    const text = block.join(" ").replace(/\s+/g, " ");
    if (reply !== undefined && CONFIRM_REQUEST.test(text) && AFFIRM.test(reply)) out.push(...findDollarAmounts(text), ...spokenAmounts(text).map((d) => d * 100));
  }
  return out;
}

/** Null any money field whose value only Haggle's own voice agent said (not the business, not a confirmed read-back). */
export function dropAgentOnlyAmounts(x: QuoteExtraction, transcript: string): QuoteExtraction {
  const lines = transcript.split("\n");
  const agentText = lines.filter(isAgentLine).join("\n");
  const agent = new Set([...findDollarAmounts(agentText), ...spokenAmounts(agentText).map((d) => d * 100)]);
  if (agent.size === 0) return x;
  const businessLines = lines.filter((l) => !isAgentLine(l)).join("\n");
  const business = new Set(findDollarAmounts(businessLines));
  for (const n of businessLines.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []) business.add(Math.round(Number(n.replace(/,/g, "")) * 100));
  for (const usd of spokenAmounts(businessLines)) business.add(usd * 100);
  for (const cents of confirmedReadBacks(lines)) business.add(cents);
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
  return out;
}

const SCREENER = /(please (?:state|say) your name|the person you(?:'re| are) calling|record your name|reason for (?:your )?call|is not available|leave (?:a|your) message|voice ?mail|after the (?:tone|beep)|mailbox is full|press \d|google voice|call screen)/i;

/** Did a completed call reach a person who said something (not just a screener, voicemail or menu)? */
export function answeredSomething(transcript: string): boolean {
  const real = businessText(transcript).split("\n").map((l) => l.trim()).filter((l) => l && !SCREENER.test(l));
  return real.join(" ").split(/\s+/).filter(Boolean).length >= 4;
}
