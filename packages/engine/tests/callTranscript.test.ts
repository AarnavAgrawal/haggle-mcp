// A real Voice AI call (fixtures/buyer/transcripts): the business said every price in words and the
// tax as a percentage; Haggle's agent read the figures back in digits and the business confirmed.
// Every figure must survive the agent-only safety net, and the total is worked out (and labelled).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dropAgentOnlyAmounts, spokenAmounts, validateQuote, type QuoteExtraction } from "../src/index.ts";

const transcript = readFileSync(join(import.meta.dirname, "../../../fixtures/buyer/transcripts/mission-eats-spoken-numbers.txt"), "utf8");
const src = (field: QuoteExtraction["sources"][number]["field"], excerpt: string) => ({ field, source: "call transcript", excerpt });

// What Claude reads from that call (only the business's lines count).
const extraction = (over: Partial<QuoteExtraction> = {}): QuoteExtraction => ({
  available: true, price_per_head_usd: 17, headcount: 40, subtotal_usd: null, delivery_fee_usd: 100, delivery_included: null, tax_usd: null, tax_included: false,
  tax_rate_percent: 10, total_usd: null, deposit_usd: 250, menu_items: [], dietary_coverage: [{ need: "Vegetarian", covered: true, count_offered: 12 }], valid_until: null,
  questions: [], payment_request: "none", instructions_to_agent: false,
  sources: [src("price_per_head", "Seventeen dollars per person"), src("delivery_fee", "a hundred dollars for delivery"), src("deposit", "Deposit, two fifty bucks")],
  missing_fields: ["total"], confidence: 0.8, ...over,
});

describe("spokenAmounts", () => {
  it("reads numbers said in words, including the colloquial 'two fifty'", () => {
    expect(spokenAmounts("Seventeen dollars per person")).toContain(17);
    expect(spokenAmounts("it'll be a hundred")).toContain(100);
    expect(spokenAmounts("Deposit, two fifty bucks")).toContain(250);
    expect(spokenAmounts("one thousand eighty delivered")).toContain(1080);
    expect(spokenAmounts("two hundred and fifty")).toContain(250);
    expect(spokenAmounts("twenty-five a head")).toContain(25);
    expect(spokenAmounts("we can't do it")).toEqual([]);
  });
});

describe("call transcript with spoken prices", () => {
  it("keeps the prices the business said in words (not dropped as agent-only)", () => {
    const out = dropAgentOnlyAmounts(extraction(), transcript);
    expect(out.price_per_head_usd).toBe(17);
    expect(out.delivery_fee_usd).toBe(100);
    expect(out.deposit_usd).toBe(250);
  });

  it("keeps a figure the business confirmed when the agent read it back", () => {
    const readBack = "local: So the all-in total is 858 dollars. Is that right?\nremote: Yes, that's right.";
    const out = dropAgentOnlyAmounts(extraction({ total_usd: 858, sources: [src("total", "858 dollars, confirmed")] }), readBack);
    expect(out.total_usd).toBe(858);
  });

  it("still drops an amount only the agent said, even with a 'yes' to a different question", () => {
    const t = "local: We have another quote of $995. Do you have a minute?\nremote: Yeah\nremote: We can do 1,050 total.";
    const out = dropAgentOnlyAmounts(extraction({ total_usd: 995, sources: [src("total", "$995")] }), t);
    expect(out.total_usd).toBeNull();
  });

  it("works out the total with the tax rate and labels it as computed", () => {
    const record = validateQuote(dropAgentOnlyAmounts(extraction(), transcript), 40);
    expect(record.tax_cents).toBe(7_800); // 10% of $680 food + $100 delivery
    expect(record.total_cents).toBe(85_800);
    expect(record.deposit_cents).toBe(25_000);
    expect(record.sources.total?.source).toMatch(/^computed from stated price per head x headcount \+ delivery fee \+ 10% tax/);
    expect(record.flags).not.toContain("tax_excluded");
  });

  it("ignores an implausible tax rate instead of guessing", () => {
    const record = validateQuote(extraction({ tax_rate_percent: 45 }), 40);
    expect(record.tax_cents).toBeNull();
    expect(record.total_cents).toBe(78_000);
    expect(record.flags).toContain("tax_excluded");
  });
});
