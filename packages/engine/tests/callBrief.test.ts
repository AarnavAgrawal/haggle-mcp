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

// The first call tells the business everything from intake and asks what the customer needs to decide.
describe("HaggleEngine.callBrief: intake content", () => {
  it("passes on details and the request's own asks, then the itemized total and the category's asks", () => {
    const fix = { short_code: "AB12", request: { what: "fix a leaking kitchen pipe", area: "Oakland, CA", venue: "12 Elm St", requirements: [], details: [{ label: "Problem", value: "drip under the sink, getting worse" }, { label: "Urgency", value: "this week" }, { label: "Budget", value: "secret" }], ask: [{ key: "earliest", label: "Earliest arrival", type: "date", required: true }] } } as never;
    const b = HaggleEngine.callBrief("Pipe Pros", fix, []);
    expect(b).toContain("Details: Problem: drip under the sink, getting worse; Urgency: this week.");
    expect(b).not.toContain("secret"); // never the budget
    expect(b).toMatch(/3\. Ask for: earliest arrival; the all-in total, itemized: subtotal, any delivery, travel, setup or service fees, tax and gratuity; any call-out, trip or diagnostic fee; whether it is a flat price or hourly/);
    expect(b).toContain("any warranty on labor and parts");
    expect(b).not.toContain("their earliest arrival time"); // the request's own ask covers it
    expect(b.length).toBeLessThanOrEqual(2000);
  });

  it("a catering call asks for the menu, the deposit and the cancellation policy, and how each must-have is met", () => {
    const b = HaggleEngine.callBrief("Mission Eats", job, ["At least 12 vegetarian meals"]);
    expect(b).toMatch(/3\. Ask for: the all-in total, itemized/);
    for (const s of ["the menu or items they would serve", "any deposit, when it is due, and payment terms", "their cancellation and change policy", "the price per person", "how each must-have is met"]) expect(b).toContain(s);
  });

  it("a long request still fits 2,000 chars with the safety lines whole: low-priority asks and details go first", () => {
    const long = { short_code: "AB12", request: { what: "movers from Oakland to Berkeley", quantity: 2, unit: "bedrooms", date: "2026-11-01", area: "Oakland, CA", requirements: Array.from({ length: 6 }, (_, i) => ({ id: `r${i}`, kind: "other", text: `Requirement number ${i} with quite a lot of words in it to fill space`, hard: true })), details: Array.from({ length: 10 }, (_, i) => ({ label: `Detail ${i}`, value: "x".repeat(80) })) } } as never;
    const reqs = Array.from({ length: 6 }, (_, i) => `Requirement number ${i} with quite a lot of words in it to fill space`);
    const b = HaggleEngine.callBrief("Bay Movers", long, reqs);
    expect(b.length).toBeLessThanOrEqual(2000);
    expect(b).toMatch(/Never agree to buy, book or pay, and never share payment details\.$/);
    expect(b).toContain("the all-in total, itemized");
  });
});

describe("HaggleEngine.rfqIMessageText: the ask", () => {
  it("adds the most decision-critical asks that fit, down to total + deposit", () => {
    const fix = { short_code: "AB12", request: { what: "fix a leak", area: "Oakland, CA", requirements: [] } } as never;
    const t = HaggleEngine.rfqIMessageText("Pipe Pros", fix);
    expect(t).toContain("All-in total, call-out fee, deposit?");
    expect(t.length).toBeLessThanOrEqual(159);
    const crowded = HaggleEngine.rfqIMessageText("Sunset Kitchen", { short_code: "AB12", request: { what: "lunch catering", quantity: 40, date: "2026-10-22", time: "12:00", area: "San Francisco, CA", requirements: [{ id: "v", kind: "dietary", text: "12 vegetarian", min_count: 12, hard: true }, { id: "d", kind: "delivery", text: "Delivered", hard: true }] } } as never);
    expect(crowded.length).toBeLessThanOrEqual(159);
    expect(crowded).toMatch(/(All-in total|Total)( \+ |, )[^?]+\?$/); // the ask ends it: no reference code to the business
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
    expect(text).toMatch(/(All-in total|Total)( \+ |, )[^?]+\?$/); // no reference code to the business
    expect(text).not.toMatch(/HG-/);
  });
});
