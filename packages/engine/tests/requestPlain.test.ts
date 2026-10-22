// Sprint 4 B: an agent can relay the user's own words for what / when / where / headcount / dietary /
// budget / delivery. Each reader is deterministic and never guesses: unreadable words come back as
// `unreadable` (the agent asks), never as an invented value.
import { describe, expect, it } from "vitest";
import { budgetFrom, dateFrom, deliveryFrom, dietaryRequirement, headcountFrom, mustHaveLine, normalizePlainRequest, timeFrom } from "../src/workflow/requestNormalize.ts";

const TODAY = "2026-10-22"; // a Thursday

describe("plain-language request facts", () => {
  it("reads headcounts, budgets and times; a bare number is never a time", () => {
    expect(headcountFrom("about 60 guests")).toBe(60);
    expect(headcountFrom("1,200 people")).toBe(1200);
    expect(headcountFrom(45)).toBe(45);
    expect(headcountFrom("a lot")).toBeUndefined();
    expect(budgetFrom("under $2,500")).toEqual({ usd: 2500, limit: false });
    expect(budgetFrom("2.5k")).toEqual({ usd: 2500, limit: false });
    expect(budgetFrom("no more than $3,000")).toEqual({ usd: 3000, limit: true });
    expect(budgetFrom("whatever it costs")).toBeUndefined();
    expect(timeFrom("11:30am")).toBe("11:30");
    expect(timeFrom("6 pm")).toBe("18:00");
    expect(timeFrom("noon")).toBe("12:00");
    expect(timeFrom("12 a.m.")).toBe("00:00");
    expect(timeFrom("Nov 14")).toBeUndefined();
    expect(timeFrom("60")).toBeUndefined();
  });

  it("reads dates, resolving relative days from today and never picking a past date", () => {
    expect(dateFrom("2026-11-14", TODAY)).toBe("2026-11-14");
    expect(dateFrom("Saturday Nov 14 at 11:30am", TODAY)).toBe("2026-11-14");
    expect(dateFrom("November 14, 2027", TODAY)).toBe("2027-11-14");
    expect(dateFrom("11/14", TODAY)).toBe("2026-11-14");
    expect(dateFrom("Oct 1", TODAY)).toBe("2027-10-01"); // already past this year
    expect(dateFrom("next Saturday", TODAY)).toBe("2026-10-24");
    expect(dateFrom("Thursday", TODAY)).toBe("2026-10-29"); // said on a Thursday: next week's
    expect(dateFrom("tomorrow", TODAY)).toBe("2026-10-23");
    expect(dateFrom("Feb 30", TODAY)).toBeUndefined();
    expect(dateFrom("sometime soon", TODAY)).toBeUndefined();
  });

  it("dietary and delivery needs stay in the user's words, made checkable", () => {
    expect(dietaryRequirement("12 vegetarian")).toBe("At least 12 vegetarian meals");
    expect(dietaryRequirement("nut-free")).toBe("nut-free");
    expect(deliveryFrom("deliver to 500 Howard St by 11:30")).toEqual({ venue: "500 Howard St", requirement: "Deliver to 500 Howard St by 11:30", time: "11:30" });
    expect(deliveryFrom("by 11am")).toEqual({ requirement: "Delivered by 11am", time: "11:00" });
    expect(mustHaveLine([{ text: "At least 12 vegetarian meals", hard: true }, { text: "nice napkins", hard: false }])).toBe("At least 12 vegetarian meals");
  });

  it("normalizePlainRequest merges everything and reports what it couldn't read", () => {
    expect(normalizePlainRequest({ headcount: "60 people", when: "Saturday Nov 14 at 11:30am", where: "San Francisco, CA", delivery: "deliver to 500 Howard St by 11:30", dietary: "12 vegetarian, nut-free" }, TODAY)).toEqual({
      quantity: 60, date: "2026-11-14", time: "11:30", area: "San Francisco, CA", venue: "500 Howard St",
      requirements: ["At least 12 vegetarian meals", "nut-free", "Deliver to 500 Howard St by 11:30"], unreadable: [],
    });
    expect(normalizePlainRequest({ headcount: "lots", when: "soonish" }, TODAY).unreadable).toEqual(['headcount "lots"', 'date "soonish"']);
    // Structured values pass through.
    expect(normalizePlainRequest({ quantity: 40, date: "2026-12-01", time: "12:00" }, TODAY)).toEqual({ quantity: 40, date: "2026-12-01", time: "12:00", requirements: [], unreadable: [] });
  });
});
