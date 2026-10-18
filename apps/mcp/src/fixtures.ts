// MOCK rehearsals only: recorded Google Places and website responses (HAGGLE_PLACES_FIXTURE=<json file>)
// so discovery → profile → selection can be exercised end to end, and by a real model, without a key
// or the network. Never used in live mode. Fixture shape:
//   { "searches": [{ "match": "plumb", "places": [<Places API place>, …] }], "websites": { "<url>": "<html>" } }
import { readFileSync } from "node:fs";
import type { PlaceResult } from "@haggle/engine";

export type PlacesFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
export type WebFetch = (url: string, init: { method: string; headers: Record<string, string>; redirect: "manual"; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

interface Fixture { searches: { match: string; places: PlaceResult[] }[]; websites?: Record<string, string> }

export function fixtureFetchers(path: string): { places: PlacesFetch; web: WebFetch; resolve: (host: string) => Promise<string[]> } {
  const fx = JSON.parse(readFileSync(path, "utf8")) as Fixture;
  const all = fx.searches.flatMap((s) => s.places);
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
  return {
    places: async (url, init) => {
      if (url.endsWith(":searchText")) {
        const q = String((JSON.parse(init.body) as { textQuery?: string }).textQuery ?? "").toLowerCase();
        if (q.includes("ratelimit")) return json(429, { error: { status: "RESOURCE_EXHAUSTED" } });
        return json(200, { places: fx.searches.filter((s) => q.includes(s.match.toLowerCase())).flatMap((s) => s.places) });
      }
      const id = decodeURIComponent(url.split("/places/")[1] ?? "");
      const p = all.find((x) => x.id === id);
      return p ? json(200, p) : json(404, { error: { status: "NOT_FOUND" } });
    },
    web: async (url) => {
      const u = new URL(url);
      const html = fx.websites?.[u.href] ?? fx.websites?.[`${u.origin}/`];
      const ok = u.pathname !== "/robots.txt" && html !== undefined;
      return { ok, status: ok ? 200 : 404, headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/html" : null) }, text: async () => (ok ? html! : "") };
    },
    resolve: async () => ["93.184.216.34"],
  };
}
