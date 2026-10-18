// PURE: deterministic sanity checks on a parsed quote.
//
// The LLM extracts; this file decides what is trustworthy. A field that fails a check is
// nulled and listed in missing_fields, and confidence is lowered, so the agent sees the gap
// instead of a wrong number.
//
// Adapted from quote-broker@8a68559 src/parser/validate.ts (Partner). Changes for Haggle v3:
//   - dollars -> cents through the engine's exact `usdToCents` (more than 2 decimals is rejected,
//     not rounded);
//   - a money figure without a source is not accepted;
//   - dietary counts, delivery/tax inclusion, seller questions, and flags for external payment
//     requests and instructions aimed at the agent.
import { MoneyError, usdToCents } from "../money.ts";
import { MONEY_FIELDS, type MoneyField, type QuoteExtraction, type QuoteRecord } from "./extraction.ts";

const MAX_MONEY_USD = 50_000;
const SUBTOTAL_TOLERANCE = 0.02;
const CONFIDENCE_PENALTY = 0.25;

export function validateQuote(x: QuoteExtraction, requestedHeadcount: number): QuoteRecord {
  const missing = new Set(x.missing_fields);
  const flags = new Set<string>();
  let failures = 0;

  const sources: QuoteRecord["sources"] = {};
  for (const s of x.sources) sources[s.field] = { source: s.source, excerpt: s.excerpt.slice(0, 200) };

  const cents = Object.fromEntries(MONEY_FIELDS.map((f) => [f, null])) as Record<MoneyField, number | null>;

  // 1. Every money value is a finite amount in [0, ceiling] with at most 2 decimals, and has a source.
  for (const field of MONEY_FIELDS) {
    const v = x[`${field}_usd`];
    if (v === null) continue;
    let c: number | null = null;
    try {
      c = usdToCents(v);
    } catch (e) {
      if (!(e instanceof MoneyError)) throw e;
    }
    if (c === null || c < 0 || c > MAX_MONEY_USD * 100) {
      missing.add(field);
      failures++;
      continue;
    }
    if (!sources[field]) {
      missing.add(field);
      flags.add("unsourced_figure");
      failures++;
      continue;
    }
    cents[field] = c;
  }

  // 2. Subtotal must be within 2% of per-head x headcount when all three exist.
  const quotedHeadcount = x.headcount;
  if (cents.price_per_head !== null && quotedHeadcount !== null && cents.subtotal !== null) {
    const expected = cents.price_per_head * quotedHeadcount;
    if (expected > 0 && Math.abs(cents.subtotal - expected) / expected > SUBTOTAL_TOLERANCE) {
      cents.subtotal = null;
      missing.add("subtotal");
      flags.add("conflicting_numbers");
      failures++;
    }
  }

  // 3. Deposit cannot exceed the total. A deposit is part of the total, never added to it.
  if (cents.deposit !== null && cents.total !== null && cents.deposit > cents.total) {
    cents.deposit = null;
    missing.add("deposit");
    flags.add("conflicting_numbers");
    failures++;
  }

  // 4. Headcount different from what we asked for is flagged, not corrected.
  if (quotedHeadcount !== null && quotedHeadcount !== requestedHeadcount) missing.add("headcount_mismatch");

  // 5. valid_until must look like a date or it is dropped.
  let validUntil = x.valid_until;
  if (validUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    validUntil = null;
    missing.add("valid_until");
  }

  // 6. Facts the ranking needs but the business didn't state.
  if (cents.total === null) missing.add("total");
  if (x.delivery_included === null && cents.delivery_fee === null) {
    missing.add("delivery");
    flags.add("delivery_unclear");
  }
  if (x.tax_included === false && cents.tax === null) flags.add("tax_excluded");
  // A deposit stated only past the first page of a PDF is the classic hidden-deposit trap.
  const depositPage = Number(sources.deposit?.source.match(/^pdf\s+p\.?\s*(\d+)/i)?.[1] ?? 0);
  if (cents.deposit !== null && depositPage > 1) flags.add("hidden_deposit");

  // 7. Untrusted-content signals. These never change a number; they only flag.
  if (x.payment_request !== "none") flags.add("external_payment_link");
  if (x.instructions_to_agent) flags.add("prompt_injection");
  if (x.questions.length > 0 && cents.total === null) flags.add("question_pending");

  const confidence = Math.max(0, Math.min(1, x.confidence - failures * CONFIDENCE_PENALTY));
  if (confidence < 0.6) flags.add("low_confidence");

  const dietary: QuoteRecord["dietary_coverage"] = {};
  for (const d of x.dietary_coverage) dietary[d.need.trim().toLowerCase()] = { covered: d.covered, count_offered: d.count_offered };

  return {
    available: x.available,
    price_per_head_cents: cents.price_per_head,
    headcount: quotedHeadcount,
    subtotal_cents: cents.subtotal,
    delivery_fee_cents: cents.delivery_fee,
    delivery_included: x.delivery_included,
    tax_cents: cents.tax,
    tax_included: x.tax_included,
    total_cents: cents.total,
    deposit_cents: cents.deposit,
    menu_items: x.menu_items.slice(0, 20),
    dietary_coverage: dietary,
    valid_until: validUntil,
    questions: x.questions.slice(0, 5).map((q) => q.slice(0, 500)),
    flags: [...flags],
    sources,
    missing_fields: [...missing],
    confidence,
  };
}

const NEED_WORDS: Record<string, RegExp> = {
  vegetarian: /\b(veg(etarian|gie|gies|an)?|plant[- ]based|meatless|meat[- ]free)\b/i,
  vegan: /\b(vegan|plant[- ]based|dairy[- ]free)\b/i,
  "gluten-free": /\b(gluten|gf|celiac|coeliac)\b/i,
  halal: /\bhalal\b/i,
  kosher: /\bkosher\b/i,
};

/**
 * A business that didn't mention a dietary need hasn't said "no": that is unknown (a follow-up),
 * never a refusal. The extraction schema asks for an entry per requested need, so a model can turn
 * silence into covered=false. When the whole reply is plain text (no PDF the text can't show),
 * drop any "not covered, no count" claim whose need the text never mentions.
 * Live regression 2026-10-18: "6000 bucks + 200 in delivery/full setup + 500 in tax" became
 * "vegetarian: can't cover" and the only quote was rejected.
 */
export function dropUnstatedDietaryRefusals(x: QuoteExtraction, text: string): QuoteExtraction {
  const mentions = (need: string) => (NEED_WORDS[need.trim().toLowerCase()] ?? new RegExp(`\\b${need.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")).test(text);
  const kept = x.dietary_coverage.filter((d) => d.covered || d.count_offered !== null || mentions(d.need));
  return kept.length === x.dietary_coverage.length ? x : { ...x, dietary_coverage: kept };
}
