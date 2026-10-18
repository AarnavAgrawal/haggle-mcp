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
import type { AskField } from "../contract.ts";
import { MoneyError, usdToCents } from "../money.ts";
import { MONEY_FIELDS, type FieldValue, type MoneyField, type QuoteExtraction, type QuoteRecord } from "./extraction.ts";

const MAX_MONEY_USD = 50_000;
const SUBTOTAL_TOLERANCE = 0.02;
/** A stated sales-tax rate above this is a misreading (US rates top out around 11%), never applied. */
const MAX_TAX_RATE_PERCENT = 20;
const CONFIDENCE_PENALTY = 0.25;
const TEXT_MAX = 300;

/**
 * One custom answer, coerced to its ask type; null when it isn't a valid value of that type
 * (never guessed). Money -> cents (≤ 2 decimals, ≤ $50k), date -> YYYY-MM-DD (a real day),
 * time -> HH:MM, boolean -> yes/no words, number -> finite, text -> clipped.
 * Ported from haggle-testing src/comms/parser/validate.ts (coerceField).
 */
export function coerceField(f: AskField, raw: string | null | undefined): FieldValue {
  if (raw === null || raw === undefined) return null;
  const v = String(raw).trim();
  if (!v) return null;
  switch (f.type) {
    case "money": {
      const m = v.replace(/usd|dollars?/gi, "").match(/-?\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)/);
      if (!m) return null;
      try {
        const c = usdToCents(m[1]!.replace(/,/g, ""));
        return c >= 0 && c <= MAX_MONEY_USD * 100 ? c : null;
      } catch {
        return null;
      }
    }
    case "number": {
      const m = v.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
      const n = m ? Number(m[0].replace(/,/g, "")) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case "date": {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return null;
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      return d.toISOString().slice(0, 10) === v ? v : null;
    }
    case "time": {
      const m = v.match(/^(\d{1,2}):(\d{2})$/);
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
      return `${m[1]!.padStart(2, "0")}:${m[2]}`;
    }
    case "boolean":
      if (/^(yes|y|true|yep|sure|we do|included)\b/i.test(v)) return true;
      if (/^(no|n|false|nope)\b/i.test(v)) return false;
      return null;
    case "text":
      return v.slice(0, TEXT_MAX);
  }
}

/** Custom answers -> validated fields + the keys still missing; money answers need a source. */
export function validateFields(answers: QuoteExtraction["answers"], ask: AskField[]): { fields: Record<string, FieldValue>; missing: string[]; failures: number; unsourced: boolean } {
  const byKey = new Map((answers ?? []).map((a) => [a.key, a]));
  const fields: Record<string, FieldValue> = {};
  const missing: string[] = [];
  let failures = 0;
  let unsourced = false;
  for (const f of ask) {
    const a = byKey.get(f.key);
    let value = coerceField(f, a?.value);
    if (a?.value != null && String(a.value).trim() && value === null) failures++;
    if (value !== null && f.type === "money" && !a?.source?.trim()) {
      value = null;
      unsourced = true;
      failures++;
    }
    fields[f.key] = value;
    if (value === null) missing.push(f.key);
  }
  return { fields, missing, failures, unsourced };
}

export function validateQuote(x: QuoteExtraction, requestedHeadcount: number | undefined, ask: AskField[] = []): QuoteRecord {
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
  // only when stated: as an amount, or as a plausible rate ("10 percent tax") on the food.
  if (x.total_usd === null && cents.total === null) {
    // A per-person price without a headcount is for the headcount we asked for.
    const heads = quotedHeadcount ?? requestedHeadcount ?? null;
    const fromHeads = cents.subtotal === null && cents.price_per_head !== null && heads !== null && heads > 0;
    const subtotal = cents.subtotal ?? (fromHeads ? cents.price_per_head! * heads! : null);
    const deliveryKnown = cents.delivery_fee !== null || x.delivery_included === true;
    if (subtotal !== null) {
      const rate = x.tax_rate_percent ?? null;
      let taxFromRate = false;
      if (cents.tax === null && x.tax_included !== true && rate !== null && rate > 0 && rate <= MAX_TAX_RATE_PERCENT) {
        cents.tax = Math.round((subtotal * rate) / 100); // on the food; a separately stated delivery fee is usually untaxed
        taxFromRate = true;
      }
      const taxAdded = cents.tax !== null && (x.tax_included === false || taxFromRate);
      cents.total = subtotal + (cents.delivery_fee ?? 0) + (taxAdded ? cents.tax! : 0);
      const parts = [fromHeads ? (quotedHeadcount !== null ? "price per head x headcount" : "price per head x requested headcount") : "subtotal", ...(cents.delivery_fee !== null ? ["delivery fee"] : []), ...(taxAdded ? [taxFromRate ? `${rate}% tax` : "tax"] : [])];
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
  if (quotedHeadcount !== null && requestedHeadcount !== undefined && quotedHeadcount !== requestedHeadcount) missing.add("headcount_mismatch");

  // 4b. Custom ask answers (any kind of request): typed, sourced, never guessed.
  const custom = ask.length ? validateFields(x.answers, ask) : null;
  if (custom) {
    failures += custom.failures;
    if (custom.unsourced) flags.add("unsourced_figure");
  }

  // 5. valid_until must look like a date or it is dropped.
  let validUntil = x.valid_until;
  if (validUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    validUntil = null;
    missing.add("valid_until");
  }

  // 6. Facts the ranking needs but the business didn't state.
  if (cents.total === null) missing.add("total");
  // Delivery is a catering-default fact; a custom request asks for what it needs instead.
  if (!custom && x.delivery_included === null && cents.delivery_fee === null) {
    missing.add("delivery");
    flags.add("delivery_unclear");
  }
  if ((x.tax_included === false || (x.tax_rate_percent ?? null) !== null) && cents.tax === null) flags.add("tax_excluded");
  // A deposit stated only past the first page of a PDF is the classic hidden-deposit trap.
  const depositPage = Number(sources.deposit?.source.match(/^pdf\s+p\.?\s*(\d+)/i)?.[1] ?? 0);
  if (cents.deposit !== null && depositPage > 1) flags.add("hidden_deposit");

  // 7. Untrusted-content signals. These never change a number; they only flag.
  if (x.payment_request !== "none") flags.add("external_payment_link");
  if (x.instructions_to_agent) flags.add("prompt_injection");
  if (x.questions.length > 0 && cents.total === null && (!custom || custom.missing.length > 0)) flags.add("question_pending");

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
    ...(custom ? { fields: custom.fields, fields_missing: custom.missing } : {}),
  };
}
