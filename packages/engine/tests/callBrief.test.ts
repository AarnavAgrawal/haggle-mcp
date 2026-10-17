// The Voice AI's call instructions: AI disclosure first, spoken date, only real competing figures.
import { describe, expect, it } from "vitest";
import { HaggleEngine } from "../src/workflow/engine.ts";

const job = { short_code: "AB12", request: { what: "lunch catering", quantity: 40, unit: null, date: "2026-10-22", area: "San Francisco, CA", requirements: [] } } as never;

describe("HaggleEngine.callBrief", () => {
  it("discloses AI first, says the date as people do, and stays under Inkbox's limit", () => {
    const b = HaggleEngine.callBrief("Mission Eats", job, ["At least 12 vegetarian meals", "Delivery included"]);
    expect(b.split("\n")[1]).toMatch(/this is Haggle, an AI assistant/);
    expect(b).toContain("Thursday, October 22");
    expect(b).toContain("Must have: At least 12 vegetarian meals; Delivery included.");
    expect(b).toContain("Do not mention other businesses or prices.");
    expect(b).toMatch(/Never agree to buy, book or pay/);
    expect(b.length).toBeLessThanOrEqual(2000);
  });
  it("cites only the real competing total it is given, and mentions the email on escalation", () => {
    const b = HaggleEngine.callBrief("Mission Eats", job, [], { competingTotalUsd: 1080, escalation: true });
    expect(b).toContain("real quote of $1,080 total");
    expect(b).toMatch(/Never invent, round down or exaggerate/);
    expect(b).toMatch(/emailed earlier/);
  });
});
