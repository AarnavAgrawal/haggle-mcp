// PURE: a deterministic fallback extractor for when Claude isn't available (no ANTHROPIC_API_KEY,
// a refusal, an outage). It reads "Label: value" lines and a few common phrasings ("$1,080 total",
// "$50 deposit", "14 vegetarian"), and is deliberately conservative: low confidence (the quote is
// flagged low_confidence), never a number it didn't see, never a quote from text it can't place.
//
// Ported from haggle-testing src/comms/parser/heuristic.ts, extended to the catering default
// (total / deposit / delivery / dietary counts) and to the call-transcript safety net
// (dropAgentOnlyAmounts, from haggle-testing extractResponse.ts).
import type { AskField } from "../contract.ts";
import { findDollarAmounts } from "../negotiation/messageGuard.ts";
import type { QuoteExtraction } from "./extraction.ts";
import type { ExtractionRequest } from "./parseReply.ts";

const DECLINE = /\b(not available|unavailable|can(?:no|')t (?:do|make|help|take)|cannot (?:do|make|help|take)|fully booked|we(?:'re| are) booked|decline|no longer)\b/i;
const INJECTION = /\b(ignore (?:your|all|any|previous|prior) (?:instructions|rules)|ai agent:|you must pay|pay now)\b/i;
const PAY_LINK = /https?:\/\/\S*(?:pay|checkout|invoice|stripe|paypal|venmo)\S*/i;
const PLEASANTRIES = /\b(how can i help|can i help you|what can i do for you|anything else)\b/i;
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lines of a call transcript spoken by Haggle's own voice agent (never the business's figures). */
export function isAgentLine(line: string): boolean {
  return /^\s*(haggle\b|local\s*:|agent\s*:|assistant\s*:|ai assistant\b)/i.test(line);
}

/** Only the business's side of a call transcript; other channels pass through unchanged. */
export function businessText(body: string, channel?: string): string {
  if (channel !== "phone") return body;
  return body.split("\n").filter((l) => l.trim() && !isAgentLine(l)).map((l) => l.replace(/^[^:]{1,60}:\s*/, "")).join("\n");
}

function labelValue(text: string, names: string[]): string | null {
  const alt = names.filter(Boolean).map(escapeRegex).join("|");
  // A label at the start of a line, or right after a sentence ("Hi! Total: $720").
  const m = text.match(new RegExp(`(?:^|\\n|[.!?]\\s+)\\s*[-*]?\\s*(?:${alt})\\s*[:=\\-–]\\s*([^\\n]+)`, "i"));
  return m ? m[1]!.trim() : null;
}

/** "$1,080 total", "total of $1,080", "Total: $1,080" -> 1080. */
function amountNear(text: string, word: string): { usd: number; excerpt: string } | null {
  const labelled = labelValue(text, [word]);
  const fromLabel = labelled ? findDollarAmounts(labelled)[0] : undefined;
  if (fromLabel !== undefined) return { usd: fromLabel / 100, excerpt: `${word}: ${labelled!}`.slice(0, 120) };
  const w = escapeRegex(word);
  const m = text.match(new RegExp(String.raw`\$\s?${NUM}\s*(?:\w+\s){0,2}?${w}\b`, "i")) ?? text.match(new RegExp(String.raw`\b${w}\s*(?:of|is|would be|will be|:)?\s*\$\s?${NUM}`, "i"));
  return m ? { usd: Number(m[1]!.replace(/,/g, "")), excerpt: m[0].slice(0, 120) } : null;
}

function answerFor(f: AskField, text: string): string | null {
  const raw = labelValue(text, [f.label, f.key, f.key.replace(/_/g, " ")]);
  if (raw) return raw;
  if (f.type !== "money") return null;
  const near = amountNear(text, f.label.toLowerCase()) ?? amountNear(text, f.key.replace(/_/g, " "));
  return near ? `$${near.usd}` : null;
}

export function heuristicExtract(input: { request: ExtractionRequest; bodyText: string }): QuoteExtraction {
  const call = input.request.channel === "phone";
  const text = businessText(input.bodyText, input.request.channel);
  const src = call ? "call transcript (heuristic)" : "email body (heuristic)";
  const total = amountNear(text, "total");
  const deposit = amountNear(text, "deposit");
  const perHead = amountNear(text, "per person") ?? amountNear(text, "per head");
  const deliveryIncluded = /delivery (?:is )?(?:included|free)|free delivery|\bdelivered\b/i.test(text) ? true : /no delivery|pick[- ]?up only/i.test(text) ? false : null;
  const delivery = deliveryIncluded ? null : amountNear(text, "delivery");
  const dietary = input.request.dietary.flatMap((d) => {
    if (!new RegExp(escapeRegex(d.need), "i").test(text)) return [];
    const m = text.match(new RegExp(String.raw`(\d+)\s*(?:of them\s*)?(?:are\s*)?${escapeRegex(d.need)}`, "i"));
    return [{ need: d.need, covered: true, count_offered: m ? Number(m[1]) : null }];
  });
  const questions = (text.match(/[^.!?\n]*\?/g) ?? []).map((q) => q.trim()).filter((q) => q && !PLEASANTRIES.test(q));
  const answers = (input.request.ask ?? []).map((f) => {
    const value = answerFor(f, text);
    return { key: f.key, value, source: value === null ? "" : src, excerpt: value === null ? "" : `${f.label}: ${value}`.slice(0, 200) };
  });
  const stated = total !== null || answers.some((a) => a.value !== null);
  const sources: QuoteExtraction["sources"] = [];
  if (total) sources.push({ field: "total", source: src, excerpt: total.excerpt });
  if (deposit) sources.push({ field: "deposit", source: src, excerpt: deposit.excerpt });
  if (perHead) sources.push({ field: "price_per_head", source: src, excerpt: perHead.excerpt });
  if (delivery) sources.push({ field: "delivery_fee", source: src, excerpt: delivery.excerpt });
  return {
    available: !DECLINE.test(text),
    price_per_head_usd: perHead?.usd ?? null,
    headcount: null,
    subtotal_usd: null,
    delivery_fee_usd: delivery?.usd ?? null,
    delivery_included: deliveryIncluded,
    tax_usd: null,
    tax_included: null,
    total_usd: total?.usd ?? null,
    deposit_usd: deposit?.usd ?? null,
    menu_items: [],
    dietary_coverage: dietary,
    valid_until: null,
    questions: questions.slice(0, 5),
    payment_request: PAY_LINK.test(text) ? "external_link" : "none",
    instructions_to_agent: INJECTION.test(text),
    sources,
    missing_fields: [...(total ? [] : ["total"]), ...(deposit ? [] : ["deposit"])],
    // Never trusted like Claude's reading: below 0.6 the quote is flagged low_confidence.
    confidence: stated ? 0.5 : 0.3,
    ...(answers.length ? { answers } : {}),
  };
}

/**
 * Call-transcript safety net: a money figure that only Haggle's own voice agent said (e.g. the
 * competing price it cited) is never the business's price. Such values are nulled and listed as
 * missing, in the catering fields and in money ask answers.
 */
export function dropAgentOnlyAmounts(x: QuoteExtraction, transcript: string, ask: AskField[] = []): QuoteExtraction {
  const lines = transcript.split("\n");
  const agent = new Set(findDollarAmounts(lines.filter(isAgentLine).join("\n")));
  if (agent.size === 0) return x;
  const businessLines = lines.filter((l) => !isAgentLine(l)).join("\n");
  const business = new Set(findDollarAmounts(businessLines));
  for (const n of businessLines.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []) business.add(Math.round(Number(n.replace(/,/g, "")) * 100));
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
