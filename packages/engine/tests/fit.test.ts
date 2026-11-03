// Discovery keeps only businesses whose MAIN line of work is the request's. Regression for a live
// catering search near SoMa (2026-11-02) that offered an architecture firm: its listing carries a
// secondary catering tag. Listing shapes below are the categories Amazon Location returned then.
import { describe, expect, it } from "vitest";
import { amazonLocationProvider, fitsCategory, kindTerms, resolveListings, searchPhrase, type AwsPlace, type ListingFetch } from "../src/index.ts";

const aws = (title: string, cats: string[]): AwsPlace => ({
  PlaceId: `AQAAA${title.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}XXXXXXXXXX`, PlaceType: "PointOfInterest", Title: title,
  Address: { Label: `${title}, San Francisco, CA`, Locality: "San Francisco" },
  Categories: cats.map((c) => ({ Id: c.replace("*", ""), Name: c.replace("*", "").replace(/_/g, " "), Primary: c.endsWith("*") })),
  Contacts: { Emails: [{ Value: `hello@${title.toLowerCase().replace(/[^a-z]/g, "")}.example` }] },
} as AwsPlace);

const CATERING_SOMA: AwsPlace[] = [
  aws("Bay of Burma", ["restaurant*", "catering_and_other_food_services"]),
  aws("Work of Art Catering & Events", ["catering_and_other_food_services*", "entertainment_and_recreation"]),
  aws("Cass Calder Smith Architecture + Interiors", ["engineering_and_scientific_services*", "catering_and_other_food_services", "interior_and_exterior_design"]),
  aws("Chef Pete Coleman", ["catering_and_other_food_services*"]),
  aws("Sam's American Eatery", ["restaurant*", "catering_and_other_food_services"]),
  aws("Goodhart Coffee Catering of San Francisco Bay Area", ["catering_and_other_food_services*", "coffee_shop"]),
  aws("Still Seville Soul Food", ["catering_and_other_food_services*", "food_market-stall"]),
];
const PLUMBING_SOMA: AwsPlace[] = [
  aws("Bayshore Plumbing Services", ["plumbing*"]),
  aws("A-1 Plumbing Supply San Francisco", ["b2b_sales_and_services*", "plumbing"]),
  aws("Alart Mechanical Contractors", ["plumbing*", "engineering_and_scientific_services", "repair_service"]),
];

const res = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body });
function provider(items: AwsPlace[], nearby: AwsPlace[] | number = 404) {
  const paths: string[] = [];
  const fetch: ListingFetch = async (url) => {
    const u = new URL(url);
    paths.push(u.pathname);
    if (u.pathname === "/v2/geocode") return res(200, { ResultItems: [{ Position: [-122.4, 37.78] }] });
    if (u.pathname === "/v2/search-text") return res(200, { ResultItems: items });
    if (u.pathname === "/v2/search-nearby") return typeof nearby === "number" ? res(nearby, { message: "no" }) : res(200, { ResultItems: nearby });
    return res(404, {});
  };
  return Object.assign(amazonLocationProvider({ apiKey: "k", fetch, now: () => new Date("2026-11-02T20:00:00Z") }), { paths });
}

describe("discovery keeps only businesses that do the work", () => {
  it("catering near SoMa: the architecture firm with a stray catering tag is left out; caterers and restaurants stay", async () => {
    const names = (await provider(CATERING_SOMA).discover("catering", "SoMa, San Francisco, CA", 12)).map((b) => b.name);
    expect(names).not.toContain("Cass Calder Smith Architecture + Interiors");
    expect(names.sort()).toEqual(["Bay of Burma", "Chef Pete Coleman", "Goodhart Coffee Catering of San Francisco Bay Area", "Sam's American Eatery", "Still Seville Soul Food", "Work of Art Catering & Events"]);
  });

  it("plumbing: a plumbing SUPPLY store (primary b2b) is left out; plumbers stay", async () => {
    const names = (await provider(PLUMBING_SOMA).discover("plumbing", "SoMa, San Francisco, CA", 12)).map((b) => b.name);
    expect(names.sort()).toEqual(["Alart Mechanical Contractors", "Bayshore Plumbing Services"]);
  });

  it("the requested count is filled from fitting businesses, not cut before the filter", async () => {
    const list = await provider(CATERING_SOMA).discover("catering", "SoMa, San Francisco, CA", 3);
    expect(list).toHaveLength(3);
    expect(list.map((b) => b.name)).not.toContain("Cass Calder Smith Architecture + Interiors");
  });

  it("Google: primaryType decides (american_restaurant fits catering; an architect never does)", () => {
    const found = resolveListings([
      { id: "g1abcdefghij", displayName: { text: "Mission Eats" }, primaryType: "american_restaurant", types: ["american_restaurant", "restaurant", "food"], formattedAddress: "SF" },
      { id: "g2abcdefghij", displayName: { text: "Studio Arch" }, primaryType: "architect", types: ["architect", "catering_service"], formattedAddress: "SF" },
    ], "catering", "San Francisco, CA");
    expect(found.filter((b) => fitsCategory("catering", b)).map((b) => b.name)).toEqual(["Mission Eats"]);
  });
});

describe("trades: the category search near the area fills in what text search misses", () => {
  const ELECTRICIANS = [aws("Daniels Electrical Services", ["electrical*"]), aws("Tucker Technology", ["electrical*"]), aws("My Oakland Electrician", ["electrical*"])];

  it("electrical near Oakland: 1 by text, the rest by category; a business found by both is listed once", async () => {
    const p = provider([ELECTRICIANS[0]!], ELECTRICIANS);
    const list = await p.discover("electrical", "Oakland, CA", 12);
    expect(list.map((b) => b.name).sort()).toEqual(["Daniels Electrical Services", "My Oakland Electrician", "Tucker Technology"]);
    expect(list.find((b) => b.name === "Daniels Electrical Services")!.merged_listings).toBe(1);
  });

  it("a failing category search never breaks discovery: the text results stand", async () => {
    const list = await provider([ELECTRICIANS[0]!], 400).discover("electrical", "Oakland, CA", 12);
    expect(list.map((b) => b.name)).toEqual(["Daniels Electrical Services"]);
  });

  it("a kind of work with no Amazon category (or an unknown one) searches by text only", async () => {
    const p = provider([aws("Petals", ["florist*"])]);
    await p.discover("florist", "Oakland, CA", 5);
    expect(p.paths).not.toContain("/v2/search-nearby");
  });

  it("rentals are searched as event rentals (a bare \"rentals\" finds a hot-tub spa); other categories as given", () => {
    expect(searchPhrase("rentals")).toBe("event rentals");
    expect(searchPhrase("plumber")).toBe("plumber");
  });

  it("repairs are home repairs: auto shops are left out", async () => {
    const list = await provider([
      aws("Valvoline Instant Oil Change", ["car_repair-service*"]), aws("H & L Auto Repair", ["car_repair*", "tire_repair"]),
      aws("Nufinishpro of San Francisco", ["specialty_trade_contractors*"]), aws("Bay Handyman", ["repair_service*"]),
    ]).discover("repairs", "SoMa, San Francisco, CA", 12);
    expect(list.map((b) => b.name).sort()).toEqual(["Bay Handyman", "Nufinishpro of San Francisco"]);
  });
});

describe("fitsCategory", () => {
  it("free-text kinds map to the right vocabulary", () => {
    expect(kindTerms("plumber")).toBe(kindTerms("plumbing"));
    expect(kindTerms("caterer")).toBe(kindTerms("catering"));
    expect(kindTerms("taco truck")).toBe(kindTerms("catering"));
    expect(kindTerms("event photographer")).toBe(kindTerms("photography"));
    expect(kindTerms("electrician")).toBe(kindTerms("electrical"));
    expect(kindTerms("movers")).toBe(kindTerms("moving"));
    expect(kindTerms("florist")).toBeNull();
  });

  it("no near-miss prefixes: a delivery service or a kitchen remodeler is not a caterer", () => {
    expect(fitsCategory("catering", { name: "Fast Couriers", primary_type: "delivery_service" })).toBe(false);
    expect(fitsCategory("catering", { name: "Bay Kitchens", primary_type: "kitchen_remodeling" })).toBe(false);
    expect(fitsCategory("catering", { name: "Molly's", primary_type: "deli" })).toBe(true);
  });

  it("without a primary category: other categories, then the name", () => {
    expect(fitsCategory("plumbing", { name: "Joe's", types: ["plumber"] })).toBe(true);
    expect(fitsCategory("plumbing", { name: "Joe's Plumbing" })).toBe(true);
    expect(fitsCategory("plumbing", { name: "Joe's", types: ["architect"] })).toBe(false);
  });

  it("an unknown kind of work needs a matching word (primary or name); an empty category is a lookup and accepts all", () => {
    expect(fitsCategory("florist", { name: "Petals", primary_type: "florist" })).toBe(true);
    expect(fitsCategory("florist", { name: "Bloom Florist SF", primary_type: "retail" })).toBe(true);
    expect(fitsCategory("florist", { name: "Bay of Burma", primary_type: "restaurant" })).toBe(false);
    expect(fitsCategory("", { name: "Anything", primary_type: "architect" })).toBe(true);
  });
});
