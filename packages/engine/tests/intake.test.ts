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
    expect(g.helpful.map((q) => q.key)).toEqual(["food", "price_range", "time", "dietary", "service"]);
    expect(g.missing[0]).toMatchObject({ question: "How many people?", field: "quantity" });
  });

  it("a full catering request is complete; what's given is never re-asked", () => {
    const g = intakeGaps({ what: "lunch catering", quantity: 40, date: "2026-10-22", time: "12:00", area: "San Francisco, CA", venue: "YC office", requirements: [{ kind: "dietary", text: "12 vegetarian meals" }] });
    expect(g.complete).toBe(true);
    expect(g.missing).toEqual([]);
    expect(g.helpful.map((q) => q.key)).toEqual(["food", "price_range", "service"]);
    expect(g.brief).toBe("lunch catering · 40 people · 2026-10-22 12:00 · YC office, San Francisco, CA · 12 vegetarian meals");
  });

  it("catering asks for a cuisine and a price point, as optional questions that land in details", () => {
    const g = intakeGaps({ what: "catering", quantity: 40, date: "2026-10-22", area: "San Francisco, CA" });
    expect(g.complete).toBe(true); // optional: the deal moves on without them
    expect(g.helpful.find((q) => q.key === "food")).toMatchObject({ field: "details: Cuisine" });
    expect(g.helpful.find((q) => q.key === "price_range")).toMatchObject({ field: "details: Price range", question: expect.stringMatching(/cheap.*fancy/i) });
  });

  it("doesn't re-ask a cuisine or price point the user already gave", () => {
    const keys = (r: Parameters<typeof intakeGaps>[0]) => intakeGaps(r).helpful.map((q) => q.key);
    expect(keys({ what: "taco bar for 40" })).not.toContain("food");
    expect(keys({ what: "catering", details: [{ label: "Cuisine", value: "Thai" }] })).not.toContain("food");
    expect(keys({ what: "catering", details: [{ label: "Price range", value: "fancy" }] })).not.toContain("price_range");
    expect(keys({ what: "cheap lunch for the team" })).not.toContain("price_range");
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
    // "How long the quote is good for" is no longer asked anywhere.
    expect(keys).toEqual(["total", "menu", "service_included", "included", "per_unit", "deposit", "availability", "cancellation"]);
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
    // Catering's cancellation policy is a follow-up term now (criticalGaps), not decision-critical.
    expect(crit("lunch catering")).toEqual(["deposit"]);
    expect(crit("tent rental")).toEqual(["deposit", "cancellation"]);
    expect(crit("fix a leak")).toEqual(["deposit"]);
  });
});

describe("criticalGaps", () => {
  it("chases the deposit and, for events, the cancellation policy, only when the reply left them out", () => {
    const r = { what: "lunch catering", quantity: 40 };
    expect(criticalGaps(r, { deposit_cents: null })).toEqual(["any deposit and when it's due"]);
    expect(criticalGaps({ what: "tent rental" }, { deposit_cents: null })).toEqual(["any deposit and when it's due", "your cancellation policy"]);
    expect(criticalGaps(r, { deposit_cents: 34500, terms: { deposit_terms: null, cancellation: "Full refund until 7 days before", exclusions: [] } })).toEqual([]);
    expect(criticalGaps({ what: "fix a leak" }, { deposit_cents: 5000 })).toEqual([]);
  });

  it("catering: asks what the first email no longer does, only when the reply leaves it out", () => {
    const r = { what: "lunch catering", quantity: 40, date: "2026-11-12" };
    // A lump sum with no menu and no cancellation policy (the per-person price follows from the total).
    expect(criticalGaps(r, { deposit_cents: 20000, total_cents: 100000, menu_items: [], price_per_head_cents: null })).toEqual([
      "your cancellation policy", "what the price includes (menu, delivery, setup)",
    ]);
    // No total and no menu: the price per person too.
    expect(criticalGaps(r, { deposit_cents: 20000, total_cents: null, menu_items: [], price_per_head_cents: null }).at(-1)).toBe("the price per person");
    // A complete quote asks nothing more.
    expect(criticalGaps(r, { deposit_cents: 20000, menu_items: ["Chicken bowls"], price_per_head_cents: 2500, terms: { deposit_terms: null, cancellation: "48 hours", exclusions: [] } })).toEqual([]);
  });
});

describe("imessageAskVariants", () => {
  it("longest first, ending with the plain total + deposit", () => {
    const v = imessageAskVariants({ what: "fix a leaking pipe" });
    expect(v[0]).toBe("All-in total, call-out fee, deposit?");
    expect(v.at(-1)).toBe("Total + deposit?");
    expect(imessageAskVariants({ what: "lunch catering" })[0]).toBe("All-in total, menu, deposit?");
  });
});

describe("the floor: what no 'go ahead anyway' can skip", () => {
  it("is what the job is and where; timing and the optional details can be skipped", () => {
    expect(intakeGaps({ what: "plumber" }).floor.map((q) => q.key)).toEqual(["problem", "where"]);
    expect(intakeGaps({ what: "fix a leaking pipe under the sink" }).floor.map((q) => q.key)).toEqual(["where"]);
    const repair = intakeGaps({ what: "fix a leaking pipe under the sink", area: "Oakland, CA" });
    expect(repair.missing.map((q) => q.key)).toEqual(["timing"]);
    expect(repair.floor).toEqual([]);
    expect(intakeGaps({ what: "lunch catering", area: "SF" }).floor.map((q) => q.key)).toEqual(["headcount"]);
    expect(intakeGaps({ what: "lunch catering", quantity: 40, area: "SF" }).floor).toEqual([]);
  });
});
