// PURE: deterministic sanity checks on a parsed quote (DESIGN.md §11.3).
//
// The LLM extracts; this file decides what is trustworthy. A field that fails a
// check is nulled and listed in missing_fields, and confidence is lowered, so
// the agent sees the gap instead of a wrong number.
import type { QuoteExtraction, QuoteRecord } from "./quoteSchema.js";

const MAX_MONEY_USD = 50_000;
const SUBTOTAL_TOLERANCE = 0.02;
const CONFIDENCE_PENALTY = 0.25;

const MONEY_FIELDS = [
  ["price_per_head_usd", "price_per_head_cents"],
  ["subtotal_usd", "subtotal_cents"],
  ["delivery_fee_usd", "delivery_fee_cents"],
  ["tax_usd", "tax_cents"],
  ["total_usd", "total_cents"],
  ["deposit_usd", "deposit_cents"],
] as const;

type CentsField = (typeof MONEY_FIELDS)[number][1];

const toCents = (usd: number) => Math.round(usd * 100);

export function validateQuote(x: QuoteExtraction, requestedHeadcount: number): QuoteRecord {
  const missing = new Set(x.missing_fields);
  let failures = 0;

  const cents: Record<CentsField, number | null> = {
    price_per_head_cents: null,
    subtotal_cents: null,
    delivery_fee_cents: null,
    tax_cents: null,
    total_cents: null,
    deposit_cents: null,
  };

  // 1. Every money value is a finite number in [0, ceiling].
  for (const [usdKey, centsKey] of MONEY_FIELDS) {
    const v = x[usdKey];
    if (v === null) continue;
    if (!Number.isFinite(v) || v < 0 || v > MAX_MONEY_USD) {
      missing.add(centsKey.replace(/_cents$/, ""));
      failures++;
      continue;
    }
    cents[centsKey] = toCents(v);
  }

  // 2. Subtotal must be within 2% of per-head x headcount when all three exist.
  const quotedHeadcount = x.headcount;
  if (cents.price_per_head_cents !== null && quotedHeadcount !== null && cents.subtotal_cents !== null) {
    const expected = cents.price_per_head_cents * quotedHeadcount;
    if (expected > 0 && Math.abs(cents.subtotal_cents - expected) / expected > SUBTOTAL_TOLERANCE) {
      cents.subtotal_cents = null;
      missing.add("subtotal");
      failures++;
    }
  }

  // 3. Deposit cannot exceed the total.
  if (cents.deposit_cents !== null && cents.total_cents !== null && cents.deposit_cents > cents.total_cents) {
    cents.deposit_cents = null;
    missing.add("deposit");
    failures++;
  }

  // 4. Headcount different from what we asked for is flagged, not corrected.
  if (quotedHeadcount !== null && quotedHeadcount !== requestedHeadcount) {
    missing.add("headcount_mismatch");
  }

  // 5. valid_until must look like a date or it is dropped.
  let validUntil = x.valid_until;
  if (validUntil !== null && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
    validUntil = null;
    missing.add("valid_until");
  }

  const confidence = Math.max(0, Math.min(1, x.confidence - failures * CONFIDENCE_PENALTY));

  const dietary: Record<string, boolean> = {};
  for (const d of x.dietary_coverage) dietary[d.need.trim().toLowerCase()] = d.covered;

  return {
    available: x.available,
    ...cents,
    headcount: quotedHeadcount,
    menu_items: x.menu_items.slice(0, 20),
    dietary_coverage: dietary,
    valid_until: validUntil,
    missing_fields: [...missing],
    confidence,
  };
}
