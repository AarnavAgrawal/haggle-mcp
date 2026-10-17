// Honesty by construction (DESIGN.md §12): every dollar figure in a
// counteroffer is a stored quote value, and competitors are never named.
import { describe, expect, it } from "vitest";
import { planCounteroffers, type CounterQuote } from "../src/negotiator/counteroffer.js";

const DEADLINE = new Date("2026-10-17T21:30:00Z");
const quotes: CounterQuote[] = [
  { vendorId: "v-bb", vendorName: "Budget Bites", perHeadCents: 1750, available: true },
  { vendorId: "v-sol", vendorName: "Taqueria Sol", perHeadCents: 2350, available: true },
  { vendorId: "v-lpf", vendorName: "Le Petit Four", perHeadCents: 3800, available: true },
  { vendorId: "v-gone", vendorName: "Closed Cafe", perHeadCents: 1200, available: false },
  { vendorId: "v-vague", vendorName: "Vague Deli", perHeadCents: null, available: true },
];

const dollars = (text: string) => [...text.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((m) => Math.round(Number(m[1]) * 100));

describe("planCounteroffers", () => {
  const plan = planCounteroffers(quotes, DEADLINE);

  it("counters only vendors that aren't already the best", () => {
    expect(plan.map((p) => p.vendorId).sort()).toEqual(["v-lpf", "v-sol"]);
  });

  it("cites the best available per-head price, ignoring unavailable and unpriced quotes", () => {
    for (const p of plan) expect(p.bestPerHeadCents).toBe(1750);
  });

  it("every dollar figure in the text is a stored, current, available quote value", () => {
    const stored = new Set(quotes.filter((q) => q.available && q.perHeadCents !== null).map((q) => q.perHeadCents));
    for (const p of plan) {
      const figures = dollars(p.text);
      expect(figures.length).toBeGreaterThan(0);
      for (const cents of figures) expect(stored.has(cents)).toBe(true);
      expect(figures).toContain(p.theirPerHeadCents);
    }
  });

  it("never names any other vendor", () => {
    for (const p of plan) {
      for (const q of quotes) {
        if (q.vendorId !== p.vendorId) expect(p.text).not.toContain(q.vendorName);
      }
    }
  });

  it("greets the vendor by name and states the deadline", () => {
    const sol = plan.find((p) => p.vendorId === "v-sol")!;
    expect(sol.text).toMatch(/^Hi Taqueria Sol,/);
    expect(sol.text).toContain("21:30 UTC");
  });

  it("sends nothing with fewer than 2 priced, available quotes", () => {
    expect(planCounteroffers(quotes.slice(0, 1), DEADLINE)).toEqual([]);
    expect(planCounteroffers([quotes[0]!, quotes[3]!, quotes[4]!], DEADLINE)).toEqual([]);
  });

  it("does not counter a vendor tied with the best price", () => {
    const tied = [quotes[0]!, { ...quotes[1]!, perHeadCents: 1750 }];
    expect(planCounteroffers(tied, DEADLINE)).toEqual([]);
  });
});
