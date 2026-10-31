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
    expect(out.subject).toBe("Quote for lunch catering for 40 – Thu Oct 22");
  });

  it("no AI self-label and no brand; the must-haves and a local reply-by day (never UTC)", () => {
    expect(out.bodyText).not.toMatch(/AI assistant|\bAI\b|Haggle|UTC/);
    // Unnamed customer: a plain "Thanks!", never an invented person.
    expect(out.bodyText.trim().split("\n").at(-1)).toBe("Thanks!");
    expect(out.bodyText).toContain("Must-haves: at least 12 vegetarian meals; delivery included.");
    // 21:30 UTC on Oct 17 is 2:30 PM Saturday in San Francisco (the default zone).
    expect(out.bodyText).toContain("please reply by Saturday, Oct 17 with");
  });

  it("does not reveal the budget unless asked to", () => {
    expect(out.bodyText).not.toContain("Budget");
  });

  it("parses dates as calendar dates regardless of timezone", () => {
    expect(humanDate("2026-01-01")).toBe("Thursday January 1");
  });

  it("asks only for the all-in price and any deposit; the rest waits for a follow-up", () => {
    expect(out.bodyText).toContain("If you can do it, please reply by Saturday, Oct 17 with your all-in price (including delivery, tax and fees) and any deposit you need. A photo or PDF of your quote is fine.");
    for (const gone of ["menu", "per person", "cancellation", "how long the quote", "must-have above", "itemized", "available"]) expect(out.bodyText.toLowerCase()).not.toContain(gone);
  });

  it("the first email for a 40-person lunch is short: one paragraph, two asks, local time, signed by the customer", () => {
    const e = buildRfqEmail({
      shortCode: "7F3K", businessName: "Mission Eats", what: "drop-off lunch", quantity: 40, date: "2026-11-12", time: "12:00", location: "San Francisco, CA", venue: "123 Market St, San Francisco",
      requirements: ["12 vegetarian meals"], replyBy: new Date("2026-11-11T01:00:00Z"), timezone: "America/Los_Angeles", now: new Date("2026-11-06T18:00:00Z"), customer: "Priya at Acme Labs",
    });
    expect(e.subject).toBe("Quote for drop-off lunch for 40 – Thu Nov 12");
    expect(e.bodyText).toBe([
      "Hi Mission Eats,",
      "",
      "Could you quote drop-off lunch for 40 people on Thursday, Nov 12 at 12:00 PM, delivered to 123 Market St, San Francisco? We need 12 vegetarian meals.",
      "",
      // 01:00 UTC on Nov 11 is still Tuesday Nov 10 in San Francisco.
      "If you can do it, please reply by Tuesday, Nov 10 with your all-in price (including delivery, tax and fees) and any deposit you need. A photo or PDF of your quote is fine.",
      "",
      "Thanks,",
      "Priya at Acme Labs",
    ].join("\n"));
    expect(e.bodyText.split(/\s+/).length).toBeLessThanOrEqual(90);
    // Exactly the two asks.
    const ask = e.bodyText.split("\n").find((l) => l.startsWith("If you can do it"))!;
    expect(ask.match(/your all-in price|any deposit/g)).toEqual(["your all-in price", "any deposit"]);
    expect(e.bodyText).not.toMatch(/AI assistant|UTC/);
  });

  it("a reply-by later today reads as a local time today", () => {
    const e = buildRfqEmail({ shortCode: "7F3K", businessName: "Bay", what: "lunch", quantity: 40, date: "2026-11-12", location: "SF", requirements: [], replyBy: new Date("2026-11-06T23:00:00Z"), timezone: "America/New_York", now: new Date("2026-11-06T15:00:00Z") });
    expect(e.bodyText).toContain("please reply by 6:00 PM today with");
  });

  it("asks a plumber for one plumber thing, signs with the customer's name, and lists the details", () => {
    const fix = buildRfqEmail({ shortCode: "7F3K", businessName: "Pipe Pros", what: "fix a leaking kitchen pipe", location: "Oakland, CA", details: [{ label: "Urgency", value: "this week" }], requirements: [], replyBy: new Date("2026-10-17T21:30:00Z"), customer: "Priya" });
    expect(fix.subject).toBe("Quote request: fix a leaking kitchen pipe");
    expect(fix.bodyText).toContain("Could you give us a quote to fix a leaking kitchen pipe in Oakland, CA? Details: Urgency: this week.");
    expect(fix.bodyText).toContain("with your all-in price (including labor, parts, any trip fee and tax), any deposit you need and your earliest arrival time.");
    expect(fix.bodyText.trim().endsWith("Thanks,\nPriya")).toBe(true);
    expect(fix.bodyText).not.toContain("price per");
    expect(fix.bodyText).not.toContain("must-have");
  });

  it("custom asks replace the all-in price ask; what they already cover isn't asked twice", () => {
    const e = buildRfqEmail({ shortCode: "7F3K", businessName: "Pipe Pros", what: "fix a sink", location: "SF", requirements: [], replyBy: new Date("2026-10-17T21:30:00Z"), askLabels: [{ label: "Total price", required: true }, { label: "Earliest date", required: true }, { label: "Deposit", required: false }] });
    expect(e.bodyText).toContain("please reply by Saturday, Oct 17 with total price, earliest date and deposit (if you can).");
    expect(e.bodyText).not.toContain("all-in price");
    expect(e.bodyText).not.toContain("any deposit");
  });

  it("asks which days work only for a flexible date range", () => {
    const e = buildRfqEmail({ shortCode: "7F3K", businessName: "Harbor", what: "lunch catering", quantity: 40, date: "2026-10-19", date_until: "2026-10-23", location: "SF", requirements: [], replyBy: new Date("2026-10-17T21:30:00Z") });
    expect(e.bodyText).toContain("on any day from Monday, Oct 19 to Friday, Oct 23");
    expect(e.bodyText).toContain("any deposit you need and which of those days you can do.");
    expect(out.bodyText).not.toContain("which of those days");
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
