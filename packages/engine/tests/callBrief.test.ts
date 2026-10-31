// The Voice AI's call instructions: AI disclosure first, spoken date, only real competing figures.
import { describe, expect, it } from "vitest";
import { HaggleEngine } from "../src/workflow/engine.ts";

const job = { short_code: "AB12", request: { what: "lunch catering", quantity: 40, unit: null, date: "2026-10-22", area: "San Francisco, CA", requirements: [] } } as never;

describe("HaggleEngine.callBrief", () => {
  it("discloses AI first, says the date as people do, and stays under Inkbox's limit", () => {
    const b = HaggleEngine.callBrief("Mission Eats", job, ["At least 12 vegetarian meals", "Delivery included"]);
    expect(b.split("\n")[0]).toMatch(/^You are an AI assistant phoning Mission Eats on behalf of a customer/);
    expect(b.split("\n")[1]).toMatch(/Open with: "Hi, I'm an AI assistant calling on behalf of a customer about a quote for lunch catering/);
    expect(b).not.toMatch(/Haggle/); // the customer's AI assistant, never a brand
    expect(b).toContain("Thursday, October 22");
    expect(b).toContain("Must have: At least 12 vegetarian meals; Delivery included.");
    expect(b).toContain("Do not mention other businesses or prices.");
    expect(b).toMatch(/Never agree to buy, book or pay/);
    // Parts or a tax rate: the agent works out the all-in total and gets it confirmed on the call.
    expect(b).toMatch(/work out the all-in total yourself/);
    expect(b).toMatch(/Is that right\?/);
    expect(b).not.toMatch(/\$\d/); // no example figures it could repeat
    expect(b.length).toBeLessThanOrEqual(2000);
  });
  it("cites only the real competing total it is given, and mentions the email on escalation", () => {
    const b = HaggleEngine.callBrief("Mission Eats", job, [], { competingTotalUsd: 1080, escalation: true });
    expect(b).toContain("real quote of $1,080 total");
    expect(b).toMatch(/Never invent, round down or exaggerate/);
    expect(b).toMatch(/emailed earlier/);
  });
  it("names the customer it calls for: a request detail, else the given name, else 'a customer'", () => {
    const named = { short_code: "AB12", request: { what: "lunch catering", quantity: 40, unit: null, date: "2026-10-22", area: "San Francisco, CA", requirements: [], details: [{ label: "Company", value: "Acme Labs" }] } } as never;
    expect(HaggleEngine.callBrief("Mission Eats", named, [])).toMatch(/Hi, I'm an AI assistant calling on behalf of Acme Labs about/);
    expect(HaggleEngine.callBrief("Mission Eats", job, [], { customer: "Priya" })).toMatch(/on behalf of Priya about/);
  });
});

// "next week" is sent as the buyer said it: a range businesses answer, never a day Haggle picked.
describe("a flexible date window", async () => {
  const { buildRfqEmail, eventWhen } = await import("../src/outbound/rfq.ts");
  const flex = { short_code: "AB12", request: { what: "drop-off catering", quantity: 25, unit: null, date: "2026-10-19", date_until: "2026-10-23", area: "San Francisco, CA", venue: "YC office", requirements: [{ id: "v", kind: "dietary", text: "5 vegetarian meals", min_count: 5, hard: true }, { id: "d", kind: "delivery", text: "Delivery included", hard: true }] } } as never;

  it("reads as a range everywhere, and businesses are asked which days work", () => {
    expect(eventWhen("2026-10-19", undefined, "2026-10-23")).toBe("any day Monday, October 19 – Friday, October 23, 2026 (flexible)");
    expect(eventWhen("2026-10-19", "12:00", "2026-10-19")).toBe("Monday, October 19, 2026 at 12:00 PM"); // a one-day "range" is just the day
    const email = buildRfqEmail({ shortCode: "AB12", businessName: "Harbor Table", what: "lunch", quantity: 25, date: "2026-10-19", date_until: "2026-10-23", location: "San Francisco", requirements: [], replyBy: new Date("2026-10-18T20:00:00Z") });
    expect(email.bodyText).toContain("- When: any day Monday, October 19 – Friday, October 23, 2026 (flexible). Please tell us which of these days you can do");
    const brief = HaggleEngine.callBrief("Mission Eats", flex, ["5 vegetarian meals"]);
    expect(brief).toContain("on any day Monday, October 19 – Friday, October 23, 2026 (flexible)");
    expect(brief).toContain("ask which of those days they can do");
    const text = HaggleEngine.rfqIMessageText("Sunset Kitchen", flex);
    expect(text).toContain("Mon, Oct 19-Fri, Oct 23 (flexible)");
    expect(text.length).toBeLessThanOrEqual(159);
    expect(text).toMatch(/Total \+ deposit\?$/); // no reference code to the business
    expect(text).not.toMatch(/HG-/);
  });
});
