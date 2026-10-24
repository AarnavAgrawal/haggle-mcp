// Sprint 4 B (from workstream E's review): the why-not line for a ranked-lower quote compares the two
// quotes pairwise; it never reuses the winner's note relative to the cheapest overall (which read as
// "ahead on price: $135 more than the lowest eligible total").
import { describe, expect, it } from "vitest";
import { scoreQuotes, type ValueInput } from "../src/index.ts";

const quote = (o: Partial<ValueInput> & { quoteId: string; totalCents: number }): ValueInput => ({
  businessId: `b_${o.quoteId}`, business: o.quoteId, depositCents: Math.round(o.totalCents * 0.2), deliveryIncluded: true, deliveryStated: true, taxStated: true, dietaryStated: true, itemsListed: true, confidence: 0.9,
  reputationStatus: "not_found", reliability: null, ...o,
});

describe("value explanation", () => {
  it("a winner that isn't the cheapest overall is described pairwise against each quote it beats on price", () => {
    const cheapest = quote({ quoteId: "c", business: "Cheapest", totalCents: 100_000, deliveryIncluded: false, taxStated: false, dietaryStated: false, itemsListed: false, depositCents: 50_000 });
    const mid = quote({ quoteId: "m", business: "Middle", totalCents: 113_500 });
    const dear = quote({ quoteId: "d", business: "Dear", totalCents: 140_000 });
    const r = scoreQuotes([cheapest, mid, dear]);
    expect(r.recommendedQuoteId).toBe("m");
    const dearLine = r.explanation!.others.find((o) => o.quote_id === "d")!.text;
    expect(dearLine).toMatch(/Middle is ahead on price: \$265 cheaper than Dear/);
    expect(dearLine).not.toMatch(/more than the lowest/);
  });
});
