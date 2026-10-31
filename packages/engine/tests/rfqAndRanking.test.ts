// RFQ text (from quote-broker@8a68559 tests/outreach.test.ts) and ranking (its pickBest cases,
// extended with the v3 golden scenario).
import { describe, expect, it } from "vitest";
import { buildRfqEmail, humanDate } from "../src/outbound/rfq.ts";
import { rankQuotes, type RankableQuote } from "../src/ranking/rank.ts";

describe("buildRfqEmail", () => {
  const out = buildRfqEmail({
    shortCode: "7F3K", businessName: "Bay Catering", what: "lunch catering", quantity: 40, date: "2026-10-22",
    location: "San Francisco, CA", requirements: ["At least 12 vegetarian meals", "Delivery included"], replyBy: new Date("2026-10-17T21:30:00Z"),
  });

  it("a plain subject with no reference code (replies are matched by Haggle's Message-IDs)", () => {
    expect(out.subject).toBe("Quote request: lunch catering, 40 people, Thursday October 22");
  });

  it("discloses that the sender is an AI agent and lists hard requirements and the deadline", () => {
    expect(out.bodyText).toContain("I'm an AI assistant reaching out on behalf of a customer.");
    expect(out.bodyText.trim().split("\n").at(-1)).toBe("AI assistant for a customer");
    expect(out.bodyText).not.toMatch(/Haggle/);
    expect(out.bodyText).toContain("  - At least 12 vegetarian meals");
    expect(out.bodyText).toContain("Saturday October 17 21:30 UTC");
  });

  it("does not reveal the budget unless asked to", () => {
    expect(out.bodyText).not.toContain("Budget");
  });

  it("parses dates as calendar dates regardless of timezone", () => {
    expect(humanDate("2026-01-01")).toBe("Thursday January 1");
  });
});

const quote = (over: Partial<RankableQuote> & Pick<RankableQuote, "quoteId" | "businessId">): RankableQuote => ({
  totalCents: 100000, available: true, compliant: true, senderTrusted: true, status: "current", confidence: 0.9, flags: [], ...over,
});

describe("rankQuotes (golden scenario, after negotiation)", () => {
  const quotes = [
    quote({ quoteId: "q-bay-1", businessId: "b-bay", totalCents: 115000, status: "superseded" }),
    quote({ quoteId: "q-bay-2", businessId: "b-bay", totalCents: 99500 }),
    quote({ quoteId: "q-harbor-2", businessId: "b-harbor", totalCents: 100800 }),
    quote({ quoteId: "q-mission-2", businessId: "b-mission", totalCents: 107000 }),
    quote({ quoteId: "q-sunset-1", businessId: "b-sunset", totalCents: 118000 }),
    quote({ quoteId: "q-grill-1", businessId: "b-grill", totalCents: 86000, compliant: false }),
    quote({ quoteId: "q-deli-1", businessId: "b-deli", totalCents: 70000, flags: ["external_payment_link", "prompt_injection"] }),
  ];

  it("recommends Bay Catering's revised $995; quotes that meet everything come first, by total", () => {
    const r = rankQuotes(quotes, 120000);
    expect(r.recommendedQuoteId).toBe("q-bay-2");
    // The cheaper Golden Grill misses a requirement: still an option, listed after the ones that meet everything.
    expect(r.ranked.map((q) => q.quoteId)).toEqual(["q-bay-2", "q-harbor-2", "q-mission-2", "q-sunset-1", "q-grill-1"]);
    expect(r.caveats).toEqual([{ quoteId: "q-grill-1", businessId: "b-grill", reasons: ["requirement_unmet"] }]);
  });

  it("rejects only what is unsafe (the scam quote) and hides superseded revisions", () => {
    expect(rankQuotes(quotes, 120000).rejected).toEqual([{ quoteId: "q-deli-1", businessId: "b-deli", reason: "external_payment_link" }]);
  });

  it("preferences are soft: an over-budget or unconfirmed quote is still an option; unpriced, unverified and unavailable ones are not", () => {
    const r = rankQuotes([
      quote({ quoteId: "a", businessId: "1", totalCents: 130000 }),
      quote({ quoteId: "b", businessId: "2", totalCents: null }),
      quote({ quoteId: "c", businessId: "3", senderTrusted: false }),
      quote({ quoteId: "d", businessId: "4", available: false }),
      quote({ quoteId: "e", businessId: "5", totalCents: 125000, compliant: false, unmet: false }),
    ], 120000);
    // Workstream D: both over budget, so neither wins by default; the unconfirmed requirement ranks
    // below the quote that confirmed everything (never as if met), even though it is cheaper.
    expect(r.recommendedQuoteId).toBeNull();
    expect(r.ranked.map((x) => x.quoteId)).toEqual(["a", "e"]);
    expect(r.caveats).toEqual(expect.arrayContaining([{ quoteId: "a", businessId: "1", reasons: ["over_budget"] }, { quoteId: "e", businessId: "5", reasons: ["requirement_unknown", "over_budget"] }]));
    expect(r.rejected.map((x) => x.reason)).toEqual(["no_total", "unverified_sender", "unavailable"]);
  });

  it("all quotes over budget: the cheapest ranks first, but nothing is recommended by default", () => {
    const r = rankQuotes([quote({ quoteId: "x", businessId: "1", totalCents: 176000 }), quote({ quoteId: "y", businessId: "2", totalCents: 302500 })], 150000);
    expect(r.ranked[0]!.quoteId).toBe("x");
    expect(r.recommendedQuoteId).toBeNull();
  });
});
