// Public-listing providers: Amazon Location Service (Places v2 with an API key) from a recorded
// fixture in its wire format, ranking without ratings, Storage vs SingleUse, typed failures, and the
// provider selection by environment. No network: every fetch is a fake.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amazonLocationProvider, googlePlacesProvider, listingProviderFromEnv, PlacesError, resolveAmazonPlaces, type AwsPlace, type ListingFetch } from "../src/index.ts";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, "../../../apps/mcp/tests/fixtures/amazon-places.json"), "utf8")) as { searches: { items: AwsPlace[] }[] };
const ITEMS = FIXTURE.searches[0]!.items;
const NOW = () => new Date("2026-10-19T19:00:00Z");
const res = (status: number, body: unknown = {}) => ({ ok: status < 400, status, json: async () => body });

function fake(over: (url: URL) => ReturnType<typeof res> | null = () => null) {
  const calls: { url: URL; method: string; body: Record<string, unknown> | null }[] = [];
  const fetch: ListingFetch = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const o = over(u);
    if (o) return o;
    if (u.pathname === "/v2/geocode") return res(200, { ResultItems: [{ Position: [-122.2711, 37.8044] }] });
    if (u.pathname === "/v2/search-text") return res(200, { ResultItems: ITEMS });
    const id = decodeURIComponent(u.pathname.split("/v2/place/")[1] ?? "");
    const p = ITEMS.find((x) => x.PlaceId === id);
    return p ? res(200, p) : res(404, { message: "not found" });
  };
  return { fetch, calls };
}

describe("Amazon Location: resolve and rank", () => {
  const found = resolveAmazonPlaces(ITEMS, "plumber", "Oakland, CA", NOW());

  it("points of interest only, duplicates merged, ranked without ratings (relevance, area, published contact, hours)", () => {
    expect(found.map((f) => f.name)).toEqual(["Ace Plumbing & Drain", "Night Owl Rooter", "Bolt Plumbing", "Quiet Drains", "Bay Pizza"]);
    const [ace] = found;
    expect(ace).toMatchObject({
      business_ref: "aws:AQAAAEFjZVBsdW1iaW5nT2FrbGFuZDAx", source: "Amazon Location Service", attribution: "Amazon Location Service (data © HERE)",
      phone: "+15105550141", website: "https://aceplumbing.example/", in_area: true, merged_listings: 2, timezone: "America/Los_Angeles", primary_type: "plumbing_service",
    });
    expect(ace).not.toHaveProperty("rating");
    expect(ace).not.toHaveProperty("maps_url");
    expect(ace!.rank_reasons.join(" | ")).toMatch(/matches "plumber".*in Oakland.*published phone \+ website.*no public rating/);
  });

  it("contacts and hours tagged for the place's own category win in a shared building", () => {
    const ace = found[0]!;
    expect(ace.phone).toBe("+15105550141"); // not the coffee shop's +15105550100
    expect(ace.hours!.display).toEqual(["Mon-Fri: 08:00 - 17:00", "Sat: 09:00 - 13:00"]);
  });

  it("listing emails (lowercased), bare website domains made https, past-midnight hours", () => {
    const bolt = found.find((f) => f.name === "Bolt Plumbing")!;
    expect(bolt.listing_emails).toEqual(["dispatch@boltplumbing.example"]);
    expect(bolt.website).toBe("https://boltplumbing.example/");
    expect(bolt).not.toHaveProperty("hours");
    expect(found.find((f) => f.name === "Night Owl Rooter")!.hours!.intervals[0]).toEqual({ day: 1, startMinute: 1080, endMinute: 1680 });
    expect(found.find((f) => f.name === "Quiet Drains")!.rank_reasons).toContain("no published phone, email or website");
    expect(found.find((f) => f.name === "Bay Pizza")!.rank_reasons[0]).toMatch(/weak match/);
  });
});

describe("Amazon Location provider (API key, plain HTTPS)", () => {
  it("discover: geocodes the area, then SearchText biased to it with Contact + TimeZone, SingleUse", async () => {
    const f = fake();
    const p = amazonLocationProvider({ apiKey: "k/ey", region: "us-west-2", fetch: f.fetch, now: NOW });
    const list = await p.discover("plumber", "Oakland, CA", 3);
    expect(list.map((b) => b.name)).toEqual(["Ace Plumbing & Drain", "Night Owl Rooter", "Bolt Plumbing"]);
    expect(f.calls.map((c) => `${c.method} ${c.url.host}${c.url.pathname}`)).toEqual(["POST places.geo.us-west-2.amazonaws.com/v2/geocode", "POST places.geo.us-west-2.amazonaws.com/v2/search-text"]);
    expect(f.calls[0]!.url.searchParams.get("key")).toBe("k/ey");
    expect(f.calls[1]!.body).toMatchObject({ QueryText: "plumber", BiasPosition: [-122.2711, 37.8044], AdditionalFeatures: ["Contact", "TimeZone"], IntendedUse: "SingleUse", MaxResults: 6 });
    // The area's position is cached briefly: a second search geocodes nothing.
    await p.discover("plumber", "oakland, ca", 3);
    expect(f.calls.filter((c) => c.url.pathname === "/v2/geocode")).toHaveLength(1);
  });

  it("details: GetPlace by id; IntendedUse=Storage when the result will be stored", async () => {
    const f = fake();
    const p = amazonLocationProvider({ apiKey: "k", fetch: f.fetch, now: NOW });
    expect(p.owns("aws:AQAAAEJvbHRQbHVtYmluZ09ha2xhbmQy")).toBe(true);
    expect(p.owns("place:ChIJ")).toBe(false);
    const bolt = await p.details("aws:AQAAAEJvbHRQbHVtYmluZ09ha2xhbmQy", { intendedUse: "Storage" });
    expect(bolt).toMatchObject({ name: "Bolt Plumbing", listing_emails: ["dispatch@boltplumbing.example"] });
    const u = f.calls[0]!.url;
    expect(u.host).toBe("places.geo.us-east-1.amazonaws.com"); // default region
    expect(u.searchParams.getAll("additional-features")).toEqual(["Contact", "TimeZone"]);
    expect(u.searchParams.get("intended-use")).toBe("Storage");
    await p.details("aws:AQAAAEJvbHRQbHVtYmluZ09ha2xhbmQy");
    expect(f.calls[1]!.url.searchParams.get("intended-use")).toBe("SingleUse");
    expect(await p.details("aws:AQAAAE5vdEZvdW5kMDAwMDAwMDAw")).toBeNull(); // 404
    expect(await p.details("aws:../../etc")).toBeNull(); // never sent
    expect(f.calls).toHaveLength(3);
  });

  it("typed failures an agent can act on", async () => {
    const fail = (status: number) => amazonLocationProvider({ apiKey: "k", fetch: fake((u) => (u.pathname === "/v2/search-text" ? res(status) : null)).fetch }).discover("plumber", "Oakland", 3);
    await expect(fail(403)).rejects.toMatchObject({ code: "key_rejected", message: expect.stringMatching(/AWS_LOCATION_API_KEY.*geo-places:SearchText/) });
    await expect(fail(429)).rejects.toMatchObject({ code: "rate_limited" });
    await expect(fail(500)).rejects.toMatchObject({ code: "unavailable" });
    const nowhere = amazonLocationProvider({ apiKey: "k", fetch: fake((u) => (u.pathname === "/v2/geocode" ? res(200, { ResultItems: [] }) : null)).fetch });
    await expect(nowhere.discover("plumber", "Atlantis", 3)).rejects.toMatchObject({ code: "area_not_found" });
    const down = amazonLocationProvider({ apiKey: "k", fetch: async () => { throw new Error("ECONNRESET"); } });
    await expect(down.discover("plumber", "Oakland", 3)).rejects.toBeInstanceOf(PlacesError);
  });
});

describe("provider selection", () => {
  it("Amazon when AWS_LOCATION_API_KEY is set, else Google Places, else off", () => {
    expect(listingProviderFromEnv({ AWS_LOCATION_API_KEY: "a", GOOGLE_PLACES_API_KEY: "g" })!.kind).toBe("amazon");
    expect(listingProviderFromEnv({ GOOGLE_PLACES_API_KEY: "g" })!).toMatchObject({ kind: "google", attribution: "Google Maps" });
    expect(listingProviderFromEnv({ AWS_LOCATION_API_KEY: "  " })).toBeNull();
    expect(listingProviderFromEnv({})).toBeNull();
  });

  it("an invalid region falls back to us-east-1", async () => {
    const f = fake();
    await amazonLocationProvider({ apiKey: "k", region: "evil.example/x", fetch: f.fetch }).details("aws:AQAAAEJvbHRQbHVtYmluZ09ha2xhbmQy");
    expect(f.calls[0]!.url.host).toBe("places.geo.us-east-1.amazonaws.com");
  });

  it("Google stays a provider: place refs, Places (New) wire format", async () => {
    const calls: string[] = [];
    const p = googlePlacesProvider({ apiKey: "g", fetch: async (url) => { calls.push(url); return res(200, { places: [{ id: "ChIJace000000001", displayName: { text: "Ace" }, businessStatus: "OPERATIONAL" }] }); } });
    expect(p.owns("place:ChIJace000000001")).toBe(true);
    expect((await p.discover("plumber", "Oakland", 3))[0]).toMatchObject({ business_ref: "place:ChIJace000000001", source: "Google Places" });
    expect(calls[0]).toBe("https://places.googleapis.com/v1/places:searchText");
  });
});
