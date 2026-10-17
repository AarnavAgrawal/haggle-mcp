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

  it("tags the subject so replies can be matched", () => {
    expect(out.subject).toBe("[HG-7F3K] Quote request: lunch catering, 40 people, Thursday October 22");
  });

  it("discloses that the sender is an AI agent and lists hard requirements and the deadline", () => {
    expect(out.bodyText).toContain("I'm an AI assistant");
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

  it("recommends Bay Catering's revised $995 and orders the rest by total", () => {
    const r = rankQuotes(quotes, 120000);
    expect(r.recommendedQuoteId).toBe("q-bay-2");
    expect(r.ranked.map((q) => q.quoteId)).toEqual(["q-bay-2", "q-harbor-2", "q-mission-2", "q-sunset-1"]);
  });

  it("rejects the cheap non-compliant and scam quotes with reasons, and hides superseded revisions", () => {
    expect(rankQuotes(quotes, 120000).rejected).toEqual([
      { quoteId: "q-grill-1", businessId: "b-grill", reason: "requirement_unmet" },
      { quoteId: "q-deli-1", businessId: "b-deli", reason: "external_payment_link" },
    ]);
  });

  it("rejects over-budget, unpriced, unverified and unavailable quotes; nothing qualifies -> no recommendation", () => {
    const r = rankQuotes([
      quote({ quoteId: "a", businessId: "1", totalCents: 130000 }),
      quote({ quoteId: "b", businessId: "2", totalCents: null }),
      quote({ quoteId: "c", businessId: "3", senderTrusted: false }),
      quote({ quoteId: "d", businessId: "4", available: false }),
    ], 120000);
    expect(r.recommendedQuoteId).toBeNull();
    expect(r.rejected.map((x) => x.reason)).toEqual(["over_budget", "no_total", "unverified_sender", "unavailable"]);
  });
});
