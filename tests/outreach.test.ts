import { describe, expect, it } from "vitest";
import { buildOutreach, humanDate } from "../src/channels/outreach.js";
import { dietaryOk, pickBest } from "../src/tools/best.js";
import type { EventDetails, QuoteRow } from "../src/db/queries.js";

const event: EventDetails = {
  date: "2026-10-24",
  time: "18:30",
  headcount: 40,
  location: "123 Main St",
  dietary: [{ need: "vegetarian", count: 6 }],
};

describe("buildOutreach", () => {
  const out = buildOutreach({ shortCode: "7F3K", vendorName: "Taqueria Sol", event, budgetPerHeadCents: 2500 });

  it("tags the subject so replies can be matched", () => {
    expect(out.subject).toBe("[QB-7F3K] Catering quote request: 40 guests, Saturday October 24");
  });

  it("discloses that the sender is an AI agent", () => {
    expect(out.bodyText).toContain("I'm an AI assistant");
  });

  it("includes dietary needs and budget", () => {
    expect(out.bodyText).toContain("6 vegetarian");
    expect(out.bodyText).toContain("$25.00/person");
  });

  it("parses dates as calendar dates regardless of timezone", () => {
    expect(humanDate("2026-01-01")).toBe("Thursday January 1");
  });
});

function quote(over: Partial<QuoteRow>): QuoteRow {
  return {
    id: "q", job_id: "j", vendor_id: "v", source_message_id: "m", round: 0, is_current: true, created_at: "",
    available: true, price_per_head_cents: 2000, headcount: 40, subtotal_cents: 80000, delivery_fee_cents: 0,
    tax_cents: null, total_cents: 80000, deposit_cents: 20000, menu_items: [], dietary_coverage: { vegetarian: true },
    valid_until: null, missing_fields: [], confidence: 0.9,
    ...over,
  };
}

describe("pickBest", () => {
  it("picks the lowest total among complete, available, dietary-covering quotes", () => {
    const quotes = [
      quote({ id: "cheap-no-veg", total_cents: 50000, dietary_coverage: { vegetarian: false } }),
      quote({ id: "cheap-unavailable", total_cents: 40000, available: false }),
      quote({ id: "no-total", total_cents: null }),
      quote({ id: "mid", total_cents: 90000 }),
      quote({ id: "best", total_cents: 80000 }),
    ];
    expect(pickBest({ event }, quotes)?.id).toBe("best");
  });

  it("returns null when nothing qualifies", () => {
    expect(pickBest({ event }, [quote({ total_cents: null })])).toBeNull();
  });

  it("treats an unstated dietary need as not covered", () => {
    expect(dietaryOk({ event }, quote({ dietary_coverage: {} }))).toBe(false);
  });
});
