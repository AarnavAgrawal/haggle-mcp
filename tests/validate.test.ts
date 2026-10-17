import { describe, expect, it } from "vitest";
import { validateQuote } from "../src/parser/validate.js";
import type { QuoteExtraction } from "../src/parser/quoteSchema.js";

const good: QuoteExtraction = {
  available: true,
  price_per_head_usd: 22.5,
  headcount: 40,
  subtotal_usd: 900,
  delivery_fee_usd: 40,
  tax_usd: null,
  total_usd: 940,
  deposit_usd: 200,
  menu_items: ["tacos", "rice"],
  dietary_coverage: [{ need: "Vegetarian", covered: true }],
  valid_until: "2026-10-22",
  missing_fields: ["tax"],
  confidence: 0.9,
};

describe("validateQuote", () => {
  it("converts dollars to integer cents and keeps a clean quote intact", () => {
    const r = validateQuote(good, 40);
    expect(r.price_per_head_cents).toBe(2250);
    expect(r.total_cents).toBe(94000);
    expect(r.deposit_cents).toBe(20000);
    expect(r.dietary_coverage).toEqual({ vegetarian: true });
    expect(r.missing_fields).toEqual(["tax"]);
    expect(r.confidence).toBe(0.9);
  });

  it("rounds floating point dollars correctly", () => {
    expect(validateQuote({ ...good, price_per_head_usd: 19.99, subtotal_usd: null }, 40).price_per_head_cents).toBe(1999);
  });

  it("drops negative or absurd amounts and lowers confidence", () => {
    const r = validateQuote({ ...good, delivery_fee_usd: -5, total_usd: 999_999 }, 40);
    expect(r.delivery_fee_cents).toBeNull();
    expect(r.total_cents).toBeNull();
    expect(r.missing_fields).toEqual(expect.arrayContaining(["delivery_fee", "total"]));
    expect(r.confidence).toBeCloseTo(0.4);
  });

  it("nulls a subtotal that is off by more than 2% from per-head x headcount", () => {
    const r = validateQuote({ ...good, subtotal_usd: 1200 }, 40);
    expect(r.subtotal_cents).toBeNull();
    expect(r.missing_fields).toContain("subtotal");
  });

  it("allows a subtotal within 2%", () => {
    expect(validateQuote({ ...good, subtotal_usd: 910 }, 40).subtotal_cents).toBe(91000);
  });

  it("nulls a deposit larger than the total", () => {
    const r = validateQuote({ ...good, deposit_usd: 5000 }, 40);
    expect(r.deposit_cents).toBeNull();
    expect(r.missing_fields).toContain("deposit");
  });

  it("flags a headcount mismatch without changing it", () => {
    const r = validateQuote({ ...good, headcount: 35, subtotal_usd: null }, 40);
    expect(r.headcount).toBe(35);
    expect(r.missing_fields).toContain("headcount_mismatch");
  });

  it("drops a malformed valid_until and clamps confidence and menu", () => {
    const r = validateQuote({ ...good, valid_until: "next friday", confidence: 7, menu_items: Array(30).fill("x") }, 40);
    expect(r.valid_until).toBeNull();
    expect(r.confidence).toBe(1);
    expect(r.menu_items).toHaveLength(20);
  });
});
