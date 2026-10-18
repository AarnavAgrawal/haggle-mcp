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

  // 2b. A total said only as parts ("$20 a meal, 200 meals, plus $100 delivery"), typical on the
  // phone: add the stated, sourced parts instead of dropping the quote, and label the total as
  // computed. Only when no total was said at all (a stated total that failed a check stays null and
  // Haggle asks); with delivery unknown the total covers the food only and says so. Tax is added
  // only when stated.
  if (x.total_usd === null && cents.total === null) {
    const fromHeads = cents.subtotal === null && cents.price_per_head !== null && quotedHeadcount !== null && quotedHeadcount > 0;
    const subtotal = cents.subtotal ?? (fromHeads ? cents.price_per_head! * quotedHeadcount! : null);
    const deliveryKnown = cents.delivery_fee !== null || x.delivery_included === true;
    if (subtotal !== null) {
      cents.total = subtotal + (cents.delivery_fee ?? 0) + (x.tax_included === false ? (cents.tax ?? 0) : 0);
      const parts = [fromHeads ? "price per head x headcount" : "subtotal", ...(cents.delivery_fee !== null ? ["delivery fee"] : []), ...(x.tax_included === false && cents.tax !== null ? ["tax"] : [])];
      const from = sources.subtotal ?? sources.price_per_head;
      sources.total = { source: `computed from stated ${parts.join(" + ")}${deliveryKnown ? "" : "; delivery not stated"}${from ? ` (${from.source})` : ""}`, excerpt: (from?.excerpt ?? "").slice(0, 200) };
      missing.delete("total");
      missing.delete("total_usd");
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

  // 8. Other fees: an amount the stated total excludes is added to the all-in total (labelled); a fee
  // whose inclusion is unclear leaves the all-in total unknown ("fees_unclear"), never guessed.
  const otherFees: NonNullable<QuoteRecord["other_fees"]> = [];
  for (const f of x.other_fees ?? []) {
    let amount: number | null = null;
    try { amount = f.amount_usd === null ? null : usdToCents(f.amount_usd); } catch { amount = null; }
    if (amount !== null && (amount < 0 || amount > MAX_MONEY_USD * 100)) amount = null;
    otherFees.push({ label: f.label.trim().slice(0, 60) || "fee", amount_cents: amount, included_in_total: f.included_in_total, excerpt: f.excerpt.trim().slice(0, 200) });
  }
  const excluded = otherFees.filter((f) => f.included_in_total === false && f.amount_cents !== null && f.amount_cents > 0);
  if (cents.total !== null && excluded.length) {
    cents.total += excluded.reduce((a, f) => a + f.amount_cents!, 0);
    const was = sources.total;
    sources.total = { source: `computed from stated total + ${excluded.map((f) => f.label).join(" + ")}${was ? ` (${was.source})` : ""}`, excerpt: [was?.excerpt, ...excluded.map((f) => f.excerpt)].filter(Boolean).join(" + ").slice(0, 200) };
  }
  if (otherFees.some((f) => f.included_in_total === null || (f.included_in_total === false && f.amount_cents === null))) flags.add("fees_unclear");
  const terms = x.terms && (x.terms.deposit_terms || x.terms.cancellation || x.terms.exclusions.length)
    ? { deposit_terms: x.terms.deposit_terms?.slice(0, 200) ?? null, cancellation: x.terms.cancellation?.slice(0, 200) ?? null, exclusions: x.terms.exclusions.map((e) => e.slice(0, 120)).slice(0, 10) }
    : undefined;

  const dietary: QuoteRecord["dietary_coverage"] = {};
  for (const d of x.dietary_coverage) dietary[d.need.trim().toLowerCase()] = { covered: d.covered, count_offered: d.count_offered };
  const answers: NonNullable<QuoteRecord["requirement_answers"]> = {};
  for (const a of x.requirement_answers ?? []) if (a.answer !== "not_stated" && a.excerpt.trim()) answers[a.requirement.trim().toLowerCase()] = { met: a.answer === "yes", excerpt: a.excerpt.trim().slice(0, 200) };

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
    ...(Object.keys(answers).length ? { requirement_answers: answers } : {}),
    ...(otherFees.length ? { other_fees: otherFees } : {}),
    ...(x.preferred_contact?.excerpt.trim() ? { preferred_contact: { channel: x.preferred_contact.channel === "text" ? "imessage" as const : x.preferred_contact.channel, excerpt: x.preferred_contact.excerpt.trim().slice(0, 160) } } : {}),
    ...(terms ? { terms } : {}),
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

/**
 * A requirement answer counts only when its quoted excerpt is really in the reply (plain-text
 * replies; PDFs can't be checked here). Unsupported answers become "not stated", never a yes or no.
 */
export function dropUnsupportedRequirementAnswers(x: QuoteExtraction, text: string): QuoteExtraction {
  if (x.preferred_contact && !text.toLowerCase().includes(x.preferred_contact.excerpt.trim().toLowerCase())) x = { ...x, preferred_contact: null };
  if (!x.requirement_answers?.length) return x;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9$]+/g, " ").trim();
  const hay = norm(text);
  const kept = x.requirement_answers.map((a) => (a.answer !== "not_stated" && (!a.excerpt.trim() || !hay.includes(norm(a.excerpt))) ? { ...a, answer: "not_stated" as const } : a));
  return { ...x, requirement_answers: kept };
}
