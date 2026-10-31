// MOCK rehearsals only: recorded public-listing and website responses (HAGGLE_PLACES_FIXTURE=<json file>)
// so discovery → profile → selection can be exercised end to end, and by a real model, without a key
// or the network. Never used in live mode. Two fixture shapes, by the listing provider they record:
//   Google Places: { "searches": [{ "match": "plumb", "places": [<Places API place>, …] }], "websites": { "<url>": "<html>" } }
//   Amazon Location: { "provider": "amazon", "geocode": [{ "match": "oakland", "position": [lng, lat] }],
//                      "searches": [{ "match": "plumb", "items": [<SearchText result item>, …] }], "websites": { … } }
import { readFileSync } from "node:fs";
import { amazonLocationProvider, googlePlacesProvider, type AwsPlace, type ListingProvider, type PlaceResult } from "@haggle/engine";

export type PlacesFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type WebFetch = (url: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

interface GoogleFixture { provider?: "google"; searches: { match: string; places: PlaceResult[] }[]; websites?: Record<string, string> }
interface AmazonFixture { provider: "amazon"; geocode?: { match: string; position: number[] }[]; searches: { match: string; items: AwsPlace[] }[]; websites?: Record<string, string> }
type Fixture = GoogleFixture | AmazonFixture;

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

function googleFetch(fx: GoogleFixture): PlacesFetch {
  const all = fx.searches.flatMap((s) => s.places);
  return async (url, init) => {
    if (url.endsWith(":searchText")) {
      const q = String((JSON.parse(init.body ?? "{}") as { textQuery?: string }).textQuery ?? "").toLowerCase();
      if (q.includes("ratelimit")) return json(429, { error: { status: "RESOURCE_EXHAUSTED" } });
      return json(200, { places: fx.searches.filter((s) => q.includes(s.match.toLowerCase())).flatMap((s) => s.places) });
    }
    const id = decodeURIComponent(url.split("/places/")[1] ?? "");
    const p = all.find((x) => x.id === id);
    return p ? json(200, p) : json(404, { error: { status: "NOT_FOUND" } });
  };
}

/** Amazon Location Places v2 wire format: /v2/geocode, /v2/search-text and /v2/place/{PlaceId}. */
function amazonFetch(fx: AmazonFixture): PlacesFetch {
  const all = fx.searches.flatMap((s) => s.items);
  return async (url, init) => {
    const u = new URL(url);
    if (!u.searchParams.get("key")) return json(403, { message: "Missing key" });
    const body = (JSON.parse(init.body ?? "{}") ?? {}) as { QueryText?: string };
    const q = String(body.QueryText ?? "").toLowerCase();
    if (u.pathname === "/v2/geocode") {
      const hit = (fx.geocode ?? []).find((g) => q.includes(g.match.toLowerCase()));
      return json(200, { ResultItems: hit ? [{ PlaceId: "area", PlaceType: "Locality", Title: body.QueryText, Position: hit.position }] : [] });
    }
    if (u.pathname === "/v2/search-text") {
      if (q.includes("ratelimit")) return json(429, { message: "Rate exceeded" });
      return json(200, { ResultItems: fx.searches.filter((s) => q.includes(s.match.toLowerCase())).flatMap((s) => s.items) });
    }
    const id = decodeURIComponent(u.pathname.split("/v2/place/")[1] ?? "");
    const p = all.find((x) => x.PlaceId === id);
    if (!p) return json(404, { message: "Place not found" });
    const { Distance: _d, ...place } = p;
    return json(200, place);
  };
}

export function fixtureFetchers(path: string): { places: PlacesFetch; listing: ListingProvider; web: WebFetch; resolve: (host: string) => Promise<string[]> } {
  const fx = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  const places = fx.provider === "amazon" ? amazonFetch(fx) : googleFetch(fx as GoogleFixture);
  const listing = fx.provider === "amazon" ? amazonLocationProvider({ apiKey: "fixture", fetch: places }) : googlePlacesProvider({ apiKey: "fixture", fetch: places });
  return {
    places, listing,
    web: async (url) => {
      const u = new URL(url);
      const html = fx.websites?.[u.href] ?? fx.websites?.[`${u.origin}/`];
      const ok = u.pathname !== "/robots.txt" && html !== undefined;
      return { ok, status: ok ? 200 : 404, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html" : null) }, text: async () => (ok ? html! : "") };
    },
    resolve: async () => ["93.184.216.34"],
  };
}
