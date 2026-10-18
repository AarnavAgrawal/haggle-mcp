// Ported from quote-broker@8a68559 tests/validate.test.ts (Partner), extended for Haggle v3
// (exact cents, sourced figures, dietary counts, untrusted-content flags, requirements).
import { describe, expect, it } from "vitest";
import { validateQuote } from "../src/parsing/validate.ts";
import { dropUnstatedDietaryRefusals } from "../src/parsing/validate.ts";
import { evaluateRequirements, meetsHardRequirements, type EngineRequirement } from "../src/parsing/requirements.ts";
import type { QuoteExtraction } from "../src/parsing/extraction.ts";

const src = (field: QuoteExtraction["sources"][number]["field"], source = "email body") => ({ field, source, excerpt: "…" });

const good: QuoteExtraction = {
  available: true,
  price_per_head_usd: 22.5,
  headcount: 40,
  subtotal_usd: 900,
  delivery_fee_usd: 40,
  delivery_included: null,
  tax_usd: null,
  tax_included: null,
  total_usd: 940,
  deposit_usd: 200,
  menu_items: ["tacos", "rice"],
  dietary_coverage: [{ need: "Vegetarian", covered: true, count_offered: 12 }],
  valid_until: "2026-10-22",
  questions: [],
  payment_request: "none",
  instructions_to_agent: false,
  sources: [src("price_per_head"), src("subtotal"), src("delivery_fee"), src("total"), src("deposit")],
  missing_fields: ["tax"],
  confidence: 0.9,
};

describe("totals stated only as parts (phone quotes)", () => {
  // The Mission Eats call: "$20 a meal, 200 meals is $4,000, $100 deposit, extra $100 for delivery and setup".
  const call: QuoteExtraction = {
    ...good, price_per_head_usd: 20, headcount: 200, subtotal_usd: 4000, delivery_fee_usd: 100, delivery_included: false, total_usd: null, deposit_usd: 100,
    sources: [src("price_per_head", "call transcript"), src("subtotal", "call transcript"), src("delivery_fee", "call transcript"), src("deposit", "call transcript")],
    missing_fields: ["tax_usd", "total_usd"],
  };

  it("adds the stated subtotal and delivery fee into a labelled total instead of dropping the quote", () => {
    const r = validateQuote(call, 200);
    expect(r.total_cents).toBe(410_000);
    expect(r.deposit_cents).toBe(10_000);
    expect(r.sources.total?.source).toMatch(/^computed from stated subtotal \+ delivery fee/);
    expect(r.missing_fields).not.toContain("total");
    expect(r.missing_fields).not.toContain("total_usd");
  });

  it("derives the subtotal from price per head x headcount when only those were said", () => {
    const r = validateQuote({ ...call, subtotal_usd: null, sources: call.sources.filter((s) => s.field !== "subtotal") }, 200);
    expect(r.total_cents).toBe(410_000);
    expect(r.sources.total?.source).toMatch(/price per head x headcount/);
  });

  it("with delivery unknown, infers the food total and says delivery isn't in it; a stated total always wins", () => {
    const r = validateQuote({ ...call, delivery_fee_usd: null, delivery_included: null, sources: call.sources.filter((s) => s.field !== "delivery_fee") }, 200);
    expect(r.total_cents).toBe(400_000);
    expect(r.sources.total?.source).toMatch(/delivery not stated/);
    expect(r.flags).toContain("delivery_unclear");
    expect(validateQuote({ ...call, total_usd: 4150, sources: [...call.sources, src("total", "call transcript")] }, 200).total_cents).toBe(415_000);
  });
});

describe("validateQuote (from quote-broker)", () => {
  it("converts dollars to integer cents and keeps a clean quote intact", () => {
    const r = validateQuote(good, 40);
    expect(r.price_per_head_cents).toBe(2250);
    expect(r.total_cents).toBe(94000);
    expect(r.deposit_cents).toBe(20000);
    expect(r.dietary_coverage).toEqual({ vegetarian: { covered: true, count_offered: 12 } });
    expect(r.missing_fields).toEqual(["tax"]);
    expect(r.flags).toEqual([]);
    expect(r.confidence).toBe(0.9);
  });

  it("converts floating point dollars exactly", () => {
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
    expect(r.flags).toContain("conflicting_numbers");
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

describe("validateQuote (v3 additions)", () => {
  it("rejects more than 2 decimals instead of rounding", () => {
    const r = validateQuote({ ...good, total_usd: 994.999 }, 40);
    expect(r.total_cents).toBeNull();
    expect(r.missing_fields).toContain("total");
  });

  it("refuses a money figure with no source", () => {
    const r = validateQuote({ ...good, sources: good.sources.filter((s) => s.field !== "total") }, 40);
    expect(r.total_cents).toBeNull();
    expect(r.flags).toContain("unsourced_figure");
  });

  it("flags a deposit found only on a later PDF page (Harbor Table trap)", () => {
    const r = validateQuote({ ...good, sources: [...good.sources.filter((s) => s.field !== "deposit"), src("deposit", "pdf p.2")] }, 40);
    expect(r.deposit_cents).toBe(20000);
    expect(r.total_cents).toBe(94000); // deposit is part of the total, not added
    expect(r.flags).toContain("hidden_deposit");
    expect(validateQuote({ ...good, sources: [...good.sources.filter((s) => s.field !== "deposit"), src("deposit", "pdf p.1")] }, 40).flags).not.toContain("hidden_deposit");
    expect(validateQuote({ ...good, sources: [...good.sources.filter((s) => s.field !== "deposit"), src("deposit", "pdf p.12")] }, 40).flags).toContain("hidden_deposit");
  });

  it("vague price stays missing, never zero (Mission Eats trap)", () => {
    const r = validateQuote({ ...good, price_per_head_usd: null, subtotal_usd: null, total_usd: null, deposit_usd: null, delivery_fee_usd: null, sources: [], confidence: 0.3, missing_fields: ["total"] }, 40);
    expect(r.total_cents).toBeNull();
    expect(r.missing_fields).toEqual(expect.arrayContaining(["total", "delivery"]));
    expect(r.flags).toEqual(expect.arrayContaining(["low_confidence", "delivery_unclear"]));
  });

  it("flags an external payment link and instructions to the agent without touching numbers (QuickQuote trap)", () => {
    const r = validateQuote({ ...good, payment_request: "external_link", instructions_to_agent: true }, 40);
    expect(r.flags).toEqual(expect.arrayContaining(["external_payment_link", "prompt_injection"]));
    expect(r.total_cents).toBe(94000);
  });

  it("keeps a seller question and flags it when no price came with it (Sunset Kitchen trap)", () => {
    const r = validateQuote({ ...good, total_usd: null, price_per_head_usd: null, subtotal_usd: null, deposit_usd: null, sources: [src("delivery_fee")], questions: ["Do you need plates?"] }, 40);
    expect(r.questions).toEqual(["Do you need plates?"]);
    expect(r.flags).toContain("question_pending");
  });
});

describe("evaluateRequirements", () => {
  const reqs: EngineRequirement[] = [
    { id: "veg12", kind: "dietary", need: "vegetarian", min_count: 12, text: "At least 12 vegetarian meals", hard: true },
    { id: "delivery", kind: "delivery", text: "Delivery included", hard: true },
    { id: "qty", kind: "quantity", text: "40 people", hard: true },
  ];

  it("passes a compliant quote", () => {
    const res = evaluateRequirements(validateQuote(good, 40), reqs, 40);
    expect(res.map((r) => r.met)).toEqual([true, true, true]);
    expect(meetsHardRequirements(res, reqs)).toBe(true);
  });

  it("rejects 6 of 12 vegetarian (Golden Grill trap)", () => {
    const q = validateQuote({ ...good, dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: 6 }] }, 40);
    const res = evaluateRequirements(q, reqs, 40);
    expect(res[0]).toEqual({ requirement_id: "veg12", met: false, reason: "only 6 of 12" });
    expect(meetsHardRequirements(res, reqs)).toBe(false);
  });

  it("treats an unstated count as unknown, never compliant", () => {
    const q = validateQuote({ ...good, dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: null }] }, 40);
    const res = evaluateRequirements(q, reqs, 40);
    expect(res[0]!.met).toBeNull();
    expect(meetsHardRequirements(res, reqs)).toBe(false);
  });
});

describe("dropUnstatedDietaryRefusals (live regression 2026-10-18)", () => {
  const base = { dietary_coverage: [{ need: "vegetarian", covered: false, count_offered: null }] } as unknown as Parameters<typeof dropUnstatedDietaryRefusals>[0];
  it("silence about a need is unknown, not a refusal", () => {
    expect(dropUnstatedDietaryRefusals(base, "6000 bucks + 200 in delivery/full setup + 500 in tax").dietary_coverage).toEqual([]);
  });
  it("an explicit no, a count, or a yes is kept", () => {
    expect(dropUnstatedDietaryRefusals(base, "Sorry, we can't do vegetarian").dietary_coverage).toHaveLength(1);
    expect(dropUnstatedDietaryRefusals(base, "no veggie options").dietary_coverage).toHaveLength(1);
    const counted = { dietary_coverage: [{ need: "vegetarian", covered: false, count_offered: 6 }] } as unknown as typeof base;
    expect(dropUnstatedDietaryRefusals(counted, "$860 total").dietary_coverage).toHaveLength(1);
    const yes = { dietary_coverage: [{ need: "vegetarian", covered: true, count_offered: null }] } as unknown as typeof base;
    expect(dropUnstatedDietaryRefusals(yes, "$860 total").dietary_coverage).toHaveLength(1);
  });
});
