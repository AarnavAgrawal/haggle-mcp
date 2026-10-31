// Intake: what kind of purchase it is, what a business needs to quote it (asked of the user before
// anything is sent), and what we ask every business back so the human can decide.
import { describe, expect, it } from "vitest";
import { classify, criticalGaps, imessageAskVariants, intakeGaps, vendorAsksFor } from "../src/intake/intake.ts";

describe("classify", () => {
  it.each([
    ["lunch catering", "catering"],
    ["hackathon catering", "catering"],
    ["taco bar for the offsite", "catering"],
    ["100 chair rentals", "event_services"],
    ["DJ for a wedding", "event_services"],
    ["event photographer", "event_services"],
    ["fix a leaking kitchen pipe", "home_repair"],
    ["plumber", "home_repair"],
    ["replace a broken outlet", "home_repair"],
    ["deep cleaning of a 2 bedroom apartment", "cleaning"],
    ["move-out cleaning", "cleaning"],
    ["movers for a 1 bedroom", "moving"],
    ["500 flyers", "printing"],
    ["custom t-shirts for the team", "printing"],
    ["cleaning crew for our catered dinner", "cleaning"],
    ["catering for a cleaning company", "catering"],
    ["accounting help", "general"],
  ])("%s -> %s", (what, cat) => {
    expect(classify({ what })).toBe(cat);
  });
});

describe("intakeGaps", () => {
  it("catering needs headcount, date and where; optional details come with it", () => {
    const g = intakeGaps({ what: "catering" });
    expect(g.category).toBe("catering");
    expect(g.missing.map((q) => q.key)).toEqual(["headcount", "date", "where"]);
    expect(g.complete).toBe(false);
    expect(g.helpful.map((q) => q.key)).toEqual(["time", "food", "dietary", "service"]);
    expect(g.missing[0]).toMatchObject({ question: "How many people?", field: "quantity" });
  });

  it("a full catering request is complete; what's given is never re-asked", () => {
    const g = intakeGaps({ what: "lunch catering", quantity: 40, date: "2026-10-22", time: "12:00", area: "San Francisco, CA", venue: "YC office", requirements: [{ kind: "dietary", text: "12 vegetarian meals" }] });
    expect(g.complete).toBe(true);
    expect(g.missing).toEqual([]);
    expect(g.helpful.map((q) => q.key)).toEqual(["service"]);
    expect(g.brief).toBe("lunch catering · 40 people · 2026-10-22 12:00 · YC office, San Francisco, CA · 12 vegetarian meals");
  });

  it("home repair asks what's wrong, where and how urgent", () => {
    expect(intakeGaps({ what: "plumber" }).missing.map((q) => q.key)).toEqual(["problem", "where", "timing"]);
    const ok = intakeGaps({ what: "fix a leaking pipe", area: "Oakland, CA", details: [{ label: "Urgency", value: "this week" }] });
    expect(ok.category).toBe("home_repair");
    expect(ok.complete).toBe(true);
    // Asking every business for its earliest date is timing ("as soon as you can").
    expect(intakeGaps({ what: "fix a leaking kitchen sink", area: "SF", ask: [{ key: "earliest_date", label: "Earliest date" }] }).complete).toBe(true);
    // "ASAP" in the user's words is timing too.
    expect(intakeGaps({ what: "plumbing repair", area: "Oakland", details: [{ label: "Problem", value: "toilet keeps running, ASAP" }] }).complete).toBe(true);
  });

  it("moving needs the route, the size and the date", () => {
    expect(intakeGaps({ what: "movers", date: "2026-11-01" }).missing.map((q) => q.key)).toEqual(["route", "size"]);
    expect(intakeGaps({ what: "movers from Oakland to Berkeley, 2 bedroom apartment", date: "2026-11-01" }).complete).toBe(true);
  });

  it("cleaning, printing, event rentals and the general fallback each have their essentials", () => {
    expect(intakeGaps({ what: "house cleaning", area: "SF" }).missing.map((q) => q.key)).toEqual(["size", "date"]);
    expect(intakeGaps({ what: "posters" }).missing.map((q) => q.key)).toEqual(["spec", "quantity", "needed_by"]);
    expect(intakeGaps({ what: "18x24 posters", quantity: 50, date: "2026-11-05" }).complete).toBe(true);
    expect(intakeGaps({ what: "tent rental", date: "2026-11-05", area: "Palo Alto" }).missing.map((q) => q.key)).toEqual(["scope"]);
    expect(intakeGaps({ what: "bookkeeping help" }).missing.map((q) => q.key)).toEqual(["where", "timing"]);
  });
});

describe("vendorAsksFor", () => {
  it("every request asks for the itemized all-in total first and the decision terms after", () => {
    const keys = vendorAsksFor({ what: "lunch catering", quantity: 40, date: "2026-10-22" }).map((a) => a.key);
    expect(keys[0]).toBe("total");
    expect(keys).toEqual(["total", "menu", "service_included", "included", "per_unit", "deposit", "availability", "cancellation", "valid_until"]);
  });

  it("category asks: plumbing asks call-out fee, flat vs hourly, parts, arrival and warranty", () => {
    const a = vendorAsksFor({ what: "fix a leaking pipe", area: "Oakland" });
    expect(a.map((x) => x.key)).toEqual(expect.arrayContaining(["callout_fee", "pricing_basis", "parts", "arrival", "warranty"]));
    expect(a.some((x) => x.key === "per_unit")).toBe(false); // nothing counted
    expect(a.find((x) => x.key === "availability")!.text).toBe("When you could do it");
  });

  it("moving, cleaning and printing have their own asks", () => {
    expect(vendorAsksFor({ what: "movers" }).map((a) => a.key)).toEqual(expect.arrayContaining(["crew_truck", "pricing_basis", "insurance"]));
    expect(vendorAsksFor({ what: "office cleaning" }).map((a) => a.key)).toEqual(expect.arrayContaining(["hours_crew", "supplies", "recurring"]));
    expect(vendorAsksFor({ what: "500 flyers", quantity: 500, unit: "flyers" }).map((a) => a.key)).toEqual(expect.arrayContaining(["proof", "turnaround", "shipping"]));
    expect(vendorAsksFor({ what: "500 flyers", quantity: 500, unit: "flyers" }).find((a) => a.key === "per_unit")!.text).toBe("The price per flyer");
  });

  it("asks the request's own ask[] already covers are left out", () => {
    const a = vendorAsksFor({ what: "fix a sink", ask: [{ key: "price", label: "Total price" }, { key: "earliest_date", label: "Earliest date" }, { key: "deposit", label: "Deposit" }] });
    const keys = a.map((x) => x.key);
    expect(keys).not.toContain("total");
    expect(keys).not.toContain("deposit");
    expect(keys).not.toContain("availability");
    expect(keys).toContain("cancellation");
  });

  it("marks what is decision-critical per category", () => {
    const crit = (what: string) => vendorAsksFor({ what }).filter((a) => a.critical).map((a) => a.key);
    expect(crit("lunch catering")).toEqual(["deposit", "cancellation"]);
    expect(crit("fix a leak")).toEqual(["deposit"]);
  });
});

describe("criticalGaps", () => {
  it("chases the deposit and, for events, the cancellation policy, only when the reply left them out", () => {
    const r = { what: "lunch catering", quantity: 40 };
    expect(criticalGaps(r, { deposit_cents: null })).toEqual(["any deposit and when it's due", "your cancellation policy"]);
    expect(criticalGaps(r, { deposit_cents: 34500, terms: { deposit_terms: null, cancellation: "Full refund until 7 days before", exclusions: [] } })).toEqual([]);
    expect(criticalGaps({ what: "fix a leak" }, { deposit_cents: 5000 })).toEqual([]);
  });
});

describe("imessageAskVariants", () => {
  it("longest first, ending with the plain total + deposit", () => {
    const v = imessageAskVariants({ what: "fix a leaking pipe" });
    expect(v[0]).toBe("All-in total, call-out fee, deposit?");
    expect(v.at(-1)).toBe("Total + deposit?");
    expect(imessageAskVariants({ what: "lunch catering" })[0]).toBe("All-in total, menu, deposit, cancellation policy?");
  });
});
