// A catering search must also reach ordinary restaurants: Domino's and Pizza Hut aren't tagged catering,
// but they take bulk orders. Regression for discover("catering") returning only businesses with
// catering in their name or tags, while discover("pizza") in the same city found a dozen restaurants.
// Preferences (cuisine, price) steer the results and never remove anything; without them the results
// span cuisines and price ranges. Listing shapes follow Amazon Location's Places v2 response.
import { describe, expect, it } from "vitest";
import { amazonLocationProvider, googlePlacesProvider, preferencesFrom, type AwsPlace, type FoundBusiness, type ListingFetch, type PlaceResult, type SearchPreferences } from "../src/index.ts";

interface Listing { cats: string[]; food?: string[]; chain?: string; email?: string }
let phones = 0; // every listing its own number: a shared phone merges two listings as one business
const aws = (title: string, o: Listing): AwsPlace => ({
  PlaceId: `AQAAA${title.replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}XXXXXXXXXX`, PlaceType: "PointOfInterest", Title: title,
  Address: { Label: `${title}, San Francisco, CA`, Locality: "San Francisco" },
  Categories: o.cats.map((c, i) => ({ Id: c, Name: c.replace(/_/g, " "), Primary: i === 0 })),
  ...(o.food ? { FoodTypes: o.food.map((f, i) => ({ Id: f, LocalizedName: f, Primary: i === 0 })) } : {}),
  ...(o.chain ? { BusinessChains: [{ Id: o.chain.replace(/\W+/g, "_"), Name: o.chain }] } : {}),
  Contacts: { Phones: [{ Value: `+1415555${String(++phones).padStart(4, "0")}` }], ...(o.email ? { Emails: [{ Value: o.email }] } : {}) },
} as AwsPlace);

const CATERERS = [
  aws("Above & Beyond Catering", { cats: ["catering_and_other_food_services"], email: "hi@above.example" }),
  aws("Foxtail Catering", { cats: ["catering_and_other_food_services"], email: "hi@foxtail.example" }),
  aws("Sorrento Catering", { cats: ["catering_and_other_food_services"], email: "hi@sorrento.example" }),
  aws("McCalls Catering", { cats: ["catering_and_other_food_services"], email: "hi@mccalls.example" }),
];
const RESTAURANTS = [
  aws("Domino's", { cats: ["fast_food"], food: ["pizza"], chain: "Domino's" }),
  aws("Pizza Hut", { cats: ["fast_food"], food: ["pizza"], chain: "Pizza Hut" }),
  aws("Taqueria Cancun", { cats: ["taqueria"], food: ["mexican"], email: "hola@cancun.example" }),
  aws("Dosa Corner", { cats: ["casual_dining"], food: ["indian"], email: "hi@dosa.example" }),
  aws("Quince Dining Room", { cats: ["fine_dining"], food: ["italian"], email: "hi@quince.example" }),
];
const INDUSTRIAL = aws("Bay Steel Supply", { cats: ["b2b_sales_and_services", "restaurant"] });

const res = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body });
type NearbyBody = { Filter?: { IncludeCategories?: string[]; IncludeFoodTypes?: string[] }; MaxResults?: number };

/** A small Amazon Location: text search knows only `text`; nearby search honours the filter it is sent. */
function amazon(text: AwsPlace[], places: AwsPlace[], failNearby: number | null = null, log?: (e: string, d: Record<string, unknown>) => void) {
  const nearby: NearbyBody[] = [];
  const texts: string[] = [];
  const fetch: ListingFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(init.body ?? "{}") as NearbyBody & { QueryText?: string };
    if (path === "/v2/geocode") return res(200, { ResultItems: [{ Position: [-122.4, 37.78] }] });
    if (path === "/v2/search-text") { texts.push(body.QueryText ?? ""); return res(200, { ResultItems: text }); }
    if (path === "/v2/search-nearby") {
      nearby.push(body);
      if (failNearby !== null) return res(failNearby, { message: "no" });
      const cats = body.Filter?.IncludeCategories, foods = body.Filter?.IncludeFoodTypes;
      return res(200, { ResultItems: places.filter((p) => (cats ?? []).some((c) => p.Categories?.some((x) => x.Id === c)) || (foods ?? []).some((f) => (p as { FoodTypes?: { Id: string }[] }).FoodTypes?.some((x) => x.Id === f))) });
    }
    return res(404);
  };
  return Object.assign(amazonLocationProvider({ apiKey: "k", fetch, now: () => new Date("2026-11-05T20:00:00Z"), ...(log ? { log } : {}) }), { nearby, texts });
}

const search = (prefs?: SearchPreferences, count = 12) => amazon(CATERERS, [...CATERERS, ...RESTAURANTS, INDUSTRIAL]).discover("catering", "San Francisco, CA", count, prefs);
const by = (list: FoundBusiness[], name: string) => list.find((b) => b.name === name)!;

describe("a catering search reaches restaurants that aren't tagged catering", () => {
  it("finds Domino's and Pizza Hut alongside the caterers", async () => {
    const names = (await search()).map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining(["Domino's", "Pizza Hut", "Above & Beyond Catering"]));
  });

  it("asks only for category and food type ids from Amazon's published list", async () => {
    const p = amazon(CATERERS, []);
    await p.discover("catering", "San Francisco, CA", 12);
    const cats = p.nearby.flatMap((n) => n.Filter?.IncludeCategories ?? []);
    const foods = p.nearby.flatMap((n) => n.Filter?.IncludeFoodTypes ?? []);
    const PUBLISHED = ["catering_and_other_food_services", "restaurant", "fast_food", "casual_dining", "fine_dining", "family_restaurant", "bistro", "take_out_and_delivery_only", "deli", "taqueria"];
    expect(cats.filter((c) => !PUBLISHED.includes(c))).toEqual([]);
    expect(foods).toEqual(expect.arrayContaining(["pizza", "sandwich"]));
    for (const n of p.nearby) expect((n.Filter?.IncludeCategories ?? []).length).toBeLessThanOrEqual(10);
  });

  it("says plainly that a restaurant isn't a listed caterer, and doesn't claim it caters", async () => {
    const d = by(await search(), "Domino's");
    expect(d.fit).toBe("adjacent");
    expect(d.rank_reasons.join(" ")).toMatch(/not listed as a caterer.*may take large orders/i);
    expect(d.rank_reasons.join(" ")).not.toMatch(/weak match/);
  });

  it("marks a business that lists catering as a specialist", async () => {
    expect(by(await search(), "Sorrento Catering").fit).toBe("specialist");
  });

  it("carries the chain, the cuisine and a rough price tier from the listing", async () => {
    expect(by(await search(), "Domino's")).toMatchObject({ chain: "Domino's", cuisine: "pizza", price_tier: "budget" });
    expect(by(await search(), "Quince Dining Room")).toMatchObject({ cuisine: "italian", price_tier: "upscale" });
    expect(by(await search(), "Dosa Corner")).toMatchObject({ cuisine: "indian", price_tier: "mid" });
  });

  it("never invents a price tier: a listing with no price signal has none", async () => {
    expect(by(await search(), "Sorrento Catering").price_tier).toBeUndefined();
  });

  it("still leaves out a business whose main line of work isn't food", async () => {
    expect((await search()).map((b) => b.name)).not.toContain("Bay Steel Supply");
  });
});

describe("a name is not a claim to cater", () => {
  const CATERINA = aws("Caterina's Trattoria", { cats: ["casual_dining"], food: ["italian"] });

  it("a restaurant whose name starts like catering is a restaurant", async () => {
    const list = await amazon([], [CATERINA]).discover("catering", "San Francisco, CA", 6);
    expect(list[0]).toMatchObject({ name: "Caterina's Trattoria", fit: "adjacent" });
    expect(list[0]!.rank_reasons.join(" ")).toMatch(/not listed as a caterer/);
    expect(list[0]!.rank_reasons.join(" ")).not.toMatch(/matches "catering"/);
  });
});

describe("with no preferences the results span the range", () => {
  it("a short list isn't all caterers: it mixes caterers and restaurants", async () => {
    const fits = new Set((await search(undefined, 6)).map((b) => b.fit));
    expect([...fits].sort()).toEqual(["adjacent", "specialist"]);
  });

  it("a short list covers several cuisines and price tiers", async () => {
    const list = await search(undefined, 6);
    expect(new Set(list.map((b) => b.cuisine).filter(Boolean)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(list.map((b) => b.price_tier).filter(Boolean)).size).toBeGreaterThanOrEqual(2);
  });

  it("gives the same order for the same listings (the confirm step re-runs the search)", async () => {
    expect((await search(undefined, 6)).map((b) => b.name)).toEqual((await search(undefined, 6)).map((b) => b.name));
  });
});

describe("preferences steer, they never remove", () => {
  it("a cuisine preference puts that cuisine first and keeps the others", async () => {
    const list = await search({ cuisine: "mexican" });
    expect(list[0]!.name).toBe("Taqueria Cancun");
    expect(list[0]!.rank_reasons.join(" ")).toMatch(/matches your mexican preference/i);
    expect(list.map((b) => b.name)).toContain("Domino's");
  });

  it("a cuisine preference searches for that food type near the area", async () => {
    const p = amazon(CATERERS, RESTAURANTS);
    await p.discover("catering", "San Francisco, CA", 6, { cuisine: "indian" });
    expect(p.nearby.flatMap((n) => n.Filter?.IncludeFoodTypes ?? [])).toContain("indian");
  });

  it("a cuisine with no Amazon food type id is searched as text, never sent as an id", async () => {
    const p = amazon(CATERERS, RESTAURANTS);
    await p.discover("catering", "San Francisco, CA", 6, { cuisine: "ethiopian" });
    expect(p.texts.join(" | ")).toMatch(/ethiopian/);
    expect(p.nearby.flatMap((n) => n.Filter?.IncludeFoodTypes ?? [])).not.toContain("ethiopian");
  });

  it("a budget preference puts budget places first; an upscale one, upscale places", async () => {
    expect((await search({ price: "budget" }))[0]!.price_tier).toBe("budget");
    expect((await search({ price: "upscale" }))[0]!.name).toBe("Quince Dining Room");
  });

  it("a cuisine matches whole words, not letters inside a name", async () => {
    const list = await amazon([], [aws("Barbecue Barn", { cats: ["casual_dining"] })]).discover("catering", "San Francisco, CA", 6, { cuisine: "bar" });
    expect(list[0]!.rank_reasons.join(" ")).not.toMatch(/matches your bar preference/);
  });

  it("a preference nothing matches still returns the options", async () => {
    expect((await search({ cuisine: "ethiopian" })).length).toBeGreaterThan(0);
  });
});

describe("failures stay visible", () => {
  it("a refused nearby search is logged and the text results stand", async () => {
    const events: [string, Record<string, unknown>][] = [];
    const p = amazon(CATERERS, [], 400, (e, d) => events.push([e, d]));
    expect((await p.discover("catering", "San Francisco, CA", 6)).map((b) => b.name)).toContain("Foxtail Catering");
    expect(events.some(([e]) => e === "listing_search_failed")).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/key=/); // the API key travels in the URL: never logged
  });
});

describe("every kind of work gets the same breadth, not just food", () => {
  const PLUMBER = aws("Bayshore Plumbing", { cats: ["plumbing"] });
  const HANDYMAN = aws("Mr Fix Handyman", { cats: ["handyman"] });
  const CONTRACTOR = aws("Bay General Contractors", { cats: ["general_contractor"] });
  const SUPPLY = aws("A-1 Pipe Supply", { cats: ["b2b_sales_and_services", "plumbing"] });

  it("a plumbing search also reaches handymen and contractors, labelled as related", async () => {
    const p = amazon([PLUMBER, HANDYMAN, CONTRACTOR], [PLUMBER]);
    const list = await p.discover("plumbing", "San Francisco, CA", 6);
    expect(p.texts).toContain("handyman");
    expect(by(list, "Bayshore Plumbing").fit).toBe("specialist");
    expect(by(list, "Mr Fix Handyman").fit).toBe("adjacent");
    expect(by(list, "Mr Fix Handyman").rank_reasons.join(" ")).toMatch(/not listed for plumbing.*may do this work/i);
    expect(by(list, "Bay General Contractors").fit).toBe("adjacent");
  });

  it("still leaves out what doesn't do the work: a supply store isn't a plumber", async () => {
    expect((await amazon([PLUMBER, SUPPLY], []).discover("plumbing", "San Francisco, CA", 6)).map((b) => b.name)).toEqual(["Bayshore Plumbing"]);
  });

  it("a printing search also reaches copy shops and office supply stores", async () => {
    const shop = aws("Bay Office Supply", { cats: ["office_supply_store"] });
    const p = amazon([shop], []);
    const list = await p.discover("printing", "San Francisco, CA", 6);
    expect(p.texts).toEqual(expect.arrayContaining(["copy shop", "office supply store"]));
    expect(list[0]).toMatchObject({ name: "Bay Office Supply", fit: "adjacent" });
  });

  it("a short list mixes specialists and related businesses", async () => {
    const plumbers = ["Ace", "Bolt", "Cora", "Dell"].map((n) => aws(`${n} Plumbing`, { cats: ["plumbing"] }));
    const fits = (await amazon([...plumbers, HANDYMAN, CONTRACTOR], []).discover("plumbing", "San Francisco, CA", 4)).map((b) => b.fit);
    expect(new Set(fits)).toEqual(new Set(["specialist", "adjacent"]));
  });

  it("a price preference steers any kind of work", async () => {
    const place = (name: string, priceLevel: string): PlaceResult => ({ id: `id-${name}`, displayName: { text: name }, formattedAddress: `${name}, San Francisco, CA`, businessStatus: "OPERATIONAL", types: ["cleaning_service"], primaryType: "cleaning_service", priceLevel });
    const fetch: ListingFetch = async () => res(200, { places: [place("Luxe Cleaning", "PRICE_LEVEL_VERY_EXPENSIVE"), place("Thrifty Cleaning", "PRICE_LEVEL_INEXPENSIVE")] });
    const list = await googlePlacesProvider({ apiKey: "k", fetch }).discover("cleaning", "San Francisco, CA", 6, { price: "budget" });
    expect(list[0]).toMatchObject({ name: "Thrifty Cleaning", price_tier: "budget" });
    expect(list[0]!.rank_reasons.join(" ")).toMatch(/matches your budget price preference/);
  });

  it("a cuisine means nothing outside food: no cuisine label, no cuisine search", async () => {
    const p = amazon([PLUMBER], [PLUMBER]);
    const list = await p.discover("plumbing", "San Francisco, CA", 6, { cuisine: "pizza" });
    expect(p.texts.join(" ")).not.toMatch(/pizza/);
    expect(list[0]).not.toHaveProperty("cuisine");
  });

  it("a plumbing search asks for no restaurants", async () => {
    const p = amazon([PLUMBER], [PLUMBER]);
    await p.discover("plumbing", "San Francisco, CA", 6);
    expect(p.nearby.flatMap((n) => n.Filter?.IncludeCategories ?? [])).toEqual(["plumbing"]);
  });

  it("work Haggle has no vocabulary for keeps what the listing search found, as a possible match", async () => {
    const florist = aws("Petal Pushers", { cats: ["florist"] });
    const list = await amazon([florist], []).discover("wedding flowers", "San Francisco, CA", 6);
    expect(list[0]).toMatchObject({ name: "Petal Pushers", fit: "adjacent" });
    expect(list[0]!.rank_reasons.join(" ")).toMatch(/may do this work/);
  });
});

describe("Google Places: same breadth, from text search", () => {
  const place = (name: string, over: Partial<PlaceResult> = {}): PlaceResult => ({
    id: `id-${name.replace(/\W+/g, "")}`, displayName: { text: name }, formattedAddress: `${name}, San Francisco, CA`, businessStatus: "OPERATIONAL",
    nationalPhoneNumber: `(415) 555-${String(name.length).padStart(4, "0")}`, ...over,
  });
  const CATERER = place("Above & Beyond Catering", { types: ["catering_service"], primaryType: "catering_service" });
  const PIZZA = place("Domino's Pizza", { types: ["pizza_restaurant", "restaurant"], primaryType: "pizza_restaurant", priceLevel: "PRICE_LEVEL_INEXPENSIVE" });
  const FANCY = place("Quince", { types: ["italian_restaurant", "restaurant"], primaryType: "italian_restaurant", priceLevel: "PRICE_LEVEL_VERY_EXPENSIVE" });

  function google() {
    const queries: string[] = [];
    const fetch: ListingFetch = async (_u, init) => {
      const q = String((JSON.parse(init.body ?? "{}") as { textQuery?: string }).textQuery);
      queries.push(q);
      return res(200, { places: /^catering/.test(q) ? [CATERER] : [PIZZA, FANCY] });
    };
    return Object.assign(googlePlacesProvider({ apiKey: "k", fetch }), { queries });
  }

  it("a catering search also looks for restaurants, and merges the results once each", async () => {
    const list = await google().discover("catering", "San Francisco, CA", 6);
    expect(list.map((b) => b.name).sort()).toEqual(["Above & Beyond Catering", "Domino's Pizza", "Quince"]);
    expect(list.every((b) => b.merged_listings === 1)).toBe(true);
  });

  it("a business called catering is a match for catering (the word used to be dropped as noise)", async () => {
    const c = by(await google().discover("catering", "San Francisco, CA", 6), "Above & Beyond Catering");
    expect(c.rank_reasons.join(" ")).not.toMatch(/weak match/);
    expect(c.fit).toBe("specialist");
  });

  it("reads the price tier from Google's price level and the cuisine from its type", async () => {
    const list = await google().discover("catering", "San Francisco, CA", 6);
    expect(by(list, "Domino's Pizza")).toMatchObject({ price_tier: "budget", cuisine: "pizza" });
    expect(by(list, "Quince")).toMatchObject({ price_tier: "upscale", cuisine: "italian" });
  });

  it("a cuisine preference adds a search for it", async () => {
    const g = google();
    await g.discover("catering", "San Francisco, CA", 6, { cuisine: "thai" });
    expect(g.queries.join(" | ")).toMatch(/thai restaurant in San Francisco/);
  });
});

describe("preferencesFrom reads the request", () => {
  it("reads the cuisine and price range details", () => {
    expect(preferencesFrom({ what: "catering", details: [{ label: "Cuisine", value: "Thai" }, { label: "Price range", value: "as cheap as possible" }] })).toEqual({ cuisine: "thai", price: "budget" });
  });

  it("understands the words people use for price", () => {
    const price = (value: string) => preferencesFrom({ what: "catering", details: [{ label: "Price range", value }] }).price;
    expect(price("fancy")).toBe("upscale");
    expect(price("high-end")).toBe("upscale");
    expect(price("mid-range")).toBe("mid");
    expect(price("affordable")).toBe("budget");
  });

  it("takes the cuisine from the request itself when it names one", () => {
    expect(preferencesFrom({ what: "taco bar for the team" }).cuisine).toBe("mexican");
    expect(preferencesFrom({ what: "pizza for 40" }).cuisine).toBe("pizza");
  });

  it("treats no preference as none, so the results span the range", () => {
    expect(preferencesFrom({ what: "catering", details: [{ label: "Cuisine", value: "no preference" }, { label: "Price range", value: "anything" }] })).toEqual({});
  });

  it("keeps a cuisine it has no id for, in the user's words", () => {
    expect(preferencesFrom({ what: "catering", details: [{ label: "Cuisine", value: "Ethiopian" }] }).cuisine).toBe("ethiopian");
  });

  it("reads a negated price word as what it is, not its opposite", () => {
    const price = (value: string) => preferencesFrom({ what: "catering", details: [{ label: "Price range", value }] }).price;
    expect(price("mid-range, nothing fancy")).toBe("mid");
    expect(price("not too fancy")).toBeUndefined();
    expect(price("not cheap")).toBeUndefined();
  });

  it("doesn't read a time of day as a price point", () => {
    expect(preferencesFrom({ what: "mid-day lunch for the team" }).price).toBeUndefined();
  });

  it("doesn't read a food allergy as a cuisine", () => {
    expect(preferencesFrom({ what: "catering", details: [{ label: "Food allergies", value: "peanuts" }] }).cuisine).toBeUndefined();
  });
});
