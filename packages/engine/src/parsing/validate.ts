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
import { MONEY_FIELDS, splitQuestions, type FieldValue, type MoneyField, type QuoteExtraction, type QuoteRecord, type TaxInfo } from "./extraction.ts";

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

const DIET_ALIASES: Record<string, RegExp> = {
  vegetarian: /\b(vegetarian|veggie|veg)\b/i,
  vegan: /\bvegan\b/i,
  "gluten-free": /\bgluten[- ]?free\b|\bgf\b/i,
  "dairy-free": /\bdairy[- ]?free\b/i,
  "nut-free": /\bnut[- ]?free\b/i,
  halal: /\bhalal\b/i,
  kosher: /\bkosher\b/i,
  pescatarian: /\bpescatarian\b/i,
};

/**
 * The requested need a business's wording refers to ("20 vegetarian", "veg meals" -> "vegetarian"),
 * so a count is never lost to a key mismatch. Unknown wording stays as written (lowercased).
 */
export function canonicalNeed(raw: string, needs: string[]): string {
  const t = raw.trim().toLowerCase();
  if (needs.includes(t)) return t;
  // "vegan" is not "vegetarian": check the more specific needs first.
  const ordered = [...needs].sort((a, b) => (a === "vegetarian" ? 1 : 0) - (b === "vegetarian" ? 1 : 0));
  for (const n of ordered) {
    const re = DIET_ALIASES[n] ?? new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (re.test(t) && !(n === "vegetarian" && /\bvegan\b/i.test(t) && needs.includes("vegan"))) return n;
  }
  return t;
}

/** Claude's per-requirement judgements, keyed by id: only listed ids; an unexplained yes/no is not trusted. */
export function validateRequirementChecks(checks: QuoteExtraction["requirement_checks"], requirementIds?: string[]): QuoteRecord["requirement_checks"] {
  if (!checks?.length) return undefined;
  const known = requirementIds ? new Set(requirementIds) : null;
  const out: NonNullable<QuoteRecord["requirement_checks"]> = {};
  for (const c of checks) {
    const id = String(c.requirement_id ?? "").trim();
    if (!id || (known && !known.has(id)) || out[id]) continue;
    const evidence = String(c.evidence ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const note = String(c.note ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const met = typeof c.met === "boolean" && (evidence || note) ? c.met : null;
    out[id] = { met, evidence, note };
  }
  return Object.keys(out).length ? out : undefined;
}

export interface ValidateOptions {
  /** The requested dietary needs (canonical names), so the business's wording maps onto them. */
  needs?: string[];
  /** The request's requirement ids; checks for anything else are dropped. */
  requirementIds?: string[];
  /**
   * The business's current trusted quote, when this reply follows it: a price-only reply (a counter
   * call: "I could do $14 a person") is worked out with the delivery fee, headcount and tax the
   * business stated before, and a tax decision it made earlier still applies.
   */
  prior?: QuoteRecord | null;
}

/** A stated total "equals" parts + tax within this many cents (rounding on a call read-back). */
const TOTAL_MATCH_CENTS = 100;

/** A usable sales-tax rate (0 to 20%), else null: a higher rate is a misreading, never applied. */
function usableRate(rate: number | null | undefined): number | null {
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= MAX_TAX_RATE_PERCENT ? rate : null;
}

/**
 * The tax judgement for this reply. Claude's `tax_status` is used when it carries the business's
 * words (an unexplained judgement isn't trusted); older extractions map `tax_included`. A reply that
 * doesn't mention tax keeps what the business said earlier: an earlier rate applies to new prices.
 */
export function taxJudgement(x: QuoteExtraction, prior?: QuoteRecord | null): TaxInfo & { rateIgnored: boolean } {
  const evidence = String(x.tax_evidence ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  let status: TaxInfo["status"];
  if (x.tax_status !== undefined) status = x.tax_status !== "not_mentioned" && !evidence ? "not_mentioned" : x.tax_status;
  else status = x.tax_included === true ? "included" : x.tax_included === false || (x.tax_rate_percent ?? null) !== null ? "added_on_top" : "not_mentioned";
  const said = status === "not_mentioned" ? null : (x.tax_rate_percent ?? null);
  const rate = usableRate(said);
  const out: TaxInfo & { rateIgnored: boolean } = { status, rate_percent: rate, evidence: status === "not_mentioned" ? "" : evidence, rateIgnored: said !== null && rate === null };
  const before = x.available && prior?.available ? prior.tax : undefined;
  if (!before || before.status === "not_mentioned") return out;
  const sameBase = before.on_delivery && (out.rate_percent === null || out.rate_percent === before.rate_percent) ? { on_delivery: true } : {};
  if (status === "not_mentioned") {
    // No new price, or a new total said without tax: as before. New prices without a total (a
    // counter call: "$14 a person"): the earlier rate applies on top of them.
    const newPricesOnly = x.total_usd === null && (x.subtotal_usd !== null || x.price_per_head_usd !== null);
    if (newPricesOnly && before.rate_percent === null && before.status === "included") return out;
    const next: TaxInfo["status"] = newPricesOnly && before.rate_percent !== null ? "added_on_top" : before.status;
    return { status: next, rate_percent: before.rate_percent, evidence: before.evidence, ...sameBase, carried: true, rateIgnored: false };
  }
  // Tax mentioned again without the rate ("plus tax"): the rate said earlier still applies.
  if (out.rate_percent === null && !out.rateIgnored && before.rate_percent !== null) return { ...out, rate_percent: before.rate_percent, ...sameBase };
  return { ...out, ...sameBase };
}

/**
 * The tax inside a stated total, when the business's own parts show it: total = food + delivery +
 * tax (a stated amount, or the stated rate on the food, or on food + delivery). Null when the
 * figures don't add up that way.
 */
function taxInsideTotal(total: number, food: number, delivery: number, statedTax: number | null, rate: number | null): { tax: number; onDelivery: boolean } | null {
  const left = total - food - delivery;
  if (left < 0) return null;
  if (statedTax !== null && Math.abs(left - statedTax) <= TOTAL_MATCH_CENTS) return { tax: statedTax, onDelivery: false };
  if (rate === null || rate === 0) return null;
  const candidates = [{ tax: Math.round((food * rate) / 100), onDelivery: false }, ...(delivery > 0 ? [{ tax: Math.round(((food + delivery) * rate) / 100), onDelivery: true }] : [])];
  const best = candidates.map((c) => ({ ...c, off: Math.abs(left - c.tax) })).sort((a, b) => a.off - b.off)[0]!;
  return best.off <= TOTAL_MATCH_CENTS ? { tax: left, onDelivery: best.onDelivery } : null;
}

export function validateQuote(x: QuoteExtraction, requestedHeadcount: number | undefined, ask: AskField[] = [], opts: ValidateOptions = {}): QuoteRecord {
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

  // 2b. Tax: Claude judges what the business said (tax_status + rate + evidence); this code only
  // does the arithmetic. A reply that doesn't mention tax keeps the business's earlier decision, and
  // a price-only reply (a counter call) is worked out with the delivery fee and headcount it stated
  // before. Rates above 20% are ignored, never applied.
  const prior = x.available && opts.prior?.available ? opts.prior : null;
  const tax = taxJudgement(x, prior);
  let taxOnDelivery = tax.on_delivery === true;
  let taxStatus = tax.status;
  let taxComputed: string | null = null;
  let taxMissing = false;
  const heads = quotedHeadcount ?? prior?.headcount ?? requestedHeadcount ?? null;
  const priorDelivery = cents.delivery_fee === null && x.delivery_included !== true && prior?.delivery_fee_cents != null ? prior.delivery_fee_cents : null;
  const delivery = cents.delivery_fee ?? priorDelivery;
  const fromHeads = cents.subtotal === null && cents.price_per_head !== null && heads !== null && heads > 0;
  const food = cents.subtotal ?? (fromHeads ? cents.price_per_head! * heads! : null);
  const rateLabel = (r: number) => `${r}% tax${tax.carried ? " stated earlier" : ""}`;
  const taxOnTop = (base: number, r: number) => Math.round(((base + (taxOnDelivery ? delivery ?? 0 : 0)) * r) / 100);

  // 2c. A total said only as parts ("$20 a meal, 200 meals, plus $100 delivery"), typical on the
  // phone: add the stated, sourced parts instead of dropping the quote, and label the total as
  // computed. Only when no total was said at all (a stated total that failed a check stays null and
  // Haggle asks); with delivery unknown the total covers the food only and says so. Tax added on top
  // is added when known (an amount, or the rate on the food); tax the business said is included
  // adds nothing; a total with tax unknown is flagged.
  if (x.total_usd === null && cents.total === null) {
    const deliveryKnown = delivery !== null || x.delivery_included === true || prior?.delivery_included === true;
    if (food !== null) {
      let fromRate = false;
      if (taxStatus === "added_on_top" && cents.tax === null && tax.rate_percent !== null) {
        cents.tax = taxOnTop(food, tax.rate_percent);
        fromRate = true;
        taxComputed = `computed: ${tax.rate_percent}% of ${taxOnDelivery ? "food + delivery" : "the food"}`;
      }
      const taxAdded = taxStatus === "added_on_top" && cents.tax !== null;
      taxMissing = cents.tax === null && taxStatus !== "included";
      cents.total = food + (delivery ?? 0) + (taxAdded ? cents.tax! : 0);
      const foodLabel = !fromHeads ? "subtotal" : quotedHeadcount !== null ? "price per head x headcount" : prior?.headcount != null ? "price per head x headcount stated earlier" : "price per head x requested headcount";
      const parts = [foodLabel, ...(delivery !== null ? [priorDelivery !== null ? "delivery fee stated earlier" : "delivery fee"] : []), ...(taxAdded ? [fromRate ? rateLabel(tax.rate_percent!) : "tax"] : [])];
      const from = sources.subtotal ?? sources.price_per_head;
      const notes = [...(taxStatus === "included" ? ["tax included"] : []), ...(deliveryKnown ? [] : ["delivery not stated"])];
      sources.total = { source: `computed from stated ${parts.join(" + ")}${notes.length ? `; ${notes.join("; ")}` : ""}${from ? ` (${from.source})` : ""}`, excerpt: (from?.excerpt ?? "").slice(0, 200) };
      missing.delete("total");
      missing.delete("total_usd");
    }
  } else if (cents.total !== null) {
    // A stated total. When the business's own parts plus its tax add up to it (a confirmed all-in
    // read-back), the tax is inside it, whatever the wording; the tax amount is the difference.
    const inside = food !== null ? taxInsideTotal(cents.total, food, delivery ?? 0, cents.tax, tax.rate_percent) : null;
    if (inside) {
      taxStatus = "included";
      taxOnDelivery = inside.onDelivery;
      if (cents.tax === null) {
        cents.tax = inside.tax;
        taxComputed = `computed: stated total - food - delivery${tax.rate_percent !== null ? ` (${tax.rate_percent}% of ${inside.onDelivery ? "food + delivery" : "the food"})` : ""}`;
      }
    } else if (taxStatus === "added_on_top") {
      // "$1,000 plus 8% tax": the tax goes on top of the stated figure, and the total says so.
      const base = food ?? cents.total - (delivery ?? 0);
      if (cents.tax === null && tax.rate_percent !== null && base >= 0) {
        cents.tax = taxOnTop(base, tax.rate_percent);
        taxComputed = `computed: ${tax.rate_percent}% of ${taxOnDelivery ? "food + delivery" : "the food"}`;
      }
      if (cents.tax !== null) {
        const stated = sources.total;
        cents.total += cents.tax;
        sources.total = { source: `computed from stated total + ${taxComputed ? rateLabel(tax.rate_percent!) : "tax"}${stated ? ` (${stated.source})` : ""}`, excerpt: (stated?.excerpt ?? "").slice(0, 200) };
      } else taxMissing = true;
    }
  }
  if (taxComputed !== null) {
    if (!sources.tax) sources.tax = { source: taxComputed, excerpt: tax.evidence };
    missing.delete("tax");
    missing.delete("tax_usd");
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
  // Tax the business said is included, or worked out from its stated rate, is never "excluded".
  if (taxMissing) flags.add("tax_excluded");
  // A deposit stated only past the first page of a PDF is the classic hidden-deposit trap.
  const depositPage = Number(sources.deposit?.source.match(/^pdf\s+p\.?\s*(\d+)/i)?.[1] ?? 0);
  if (cents.deposit !== null && depositPage > 1) flags.add("hidden_deposit");

  // 7. Untrusted-content signals. These never change a number; they only flag.
  if (x.payment_request !== "none") flags.add("external_payment_link");
  if (x.instructions_to_agent) flags.add("prompt_injection");
  // Courtesy questions ("will you be using us?") need no answer and hold nothing.
  const asked = splitQuestions(x.questions);
  if (asked.blocking.length > 0 && cents.total === null && (!custom || custom.missing.length > 0)) flags.add("question_pending");

  const confidence = Math.max(0, Math.min(1, x.confidence - failures * CONFIDENCE_PENALTY));
  if (confidence < 0.6) flags.add("low_confidence");

  const dietary: QuoteRecord["dietary_coverage"] = {};
  for (const d of x.dietary_coverage) {
    const key = canonicalNeed(d.need, opts.needs ?? []);
    const prev = dietary[key];
    // Two entries for one need ("vegetarian" and "20 vegetarian"): the one that says more wins.
    const rank = (e: { covered: boolean; count_offered: number | null }) => (e.count_offered !== null ? 2 : 0) + (e.covered ? 1 : 0);
    const next = { covered: d.covered, count_offered: d.count_offered };
    if (!prev || rank(next) > rank(prev)) dietary[key] = next;
  }
  const checks = validateRequirementChecks(x.requirement_checks, opts.requirementIds);

  return {
    available: x.available,
    price_per_head_cents: cents.price_per_head,
    headcount: quotedHeadcount,
    subtotal_cents: cents.subtotal,
    delivery_fee_cents: cents.delivery_fee,
    delivery_included: x.delivery_included,
    tax_cents: cents.tax,
    tax_included: taxStatus === "included" ? true : taxStatus === "added_on_top" ? false : null,
    tax: { status: taxStatus, rate_percent: tax.rate_percent, evidence: tax.evidence, ...(taxOnDelivery ? { on_delivery: true } : {}), ...(tax.carried ? { carried: true } : {}) },
    total_cents: cents.total,
    deposit_cents: cents.deposit,
    menu_items: x.menu_items.slice(0, 20),
    dietary_coverage: dietary,
    valid_until: validUntil,
    questions: asked.blocking.slice(0, 5).map((q) => q.slice(0, 500)),
    ...(asked.courtesy.length ? { courtesy_questions: asked.courtesy.slice(0, 5).map((q) => q.slice(0, 300)) } : {}),
    flags: [...flags],
    sources,
    missing_fields: [...missing],
    confidence,
    ...(custom ? { fields: custom.fields, fields_missing: custom.missing } : {}),
    ...(checks ? { requirement_checks: checks } : {}),
  };
}
