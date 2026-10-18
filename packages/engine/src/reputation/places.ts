// Public reputation for real businesses, from a listing API (Google Places API (New) Text Search).
//
// - Off unless GOOGLE_PLACES_API_KEY is set; fictional demo vendors (simulated) are never looked up.
// - Non-blocking: `peek` answers from the cache at once ("pending" while a lookup runs in the
//   background) so a deal board never waits on a third party; the next read shows the result.
// - Attribution and uncertainty are kept: source, rating, review count, the listing's own name and a
//   match confidence (phone match = sure; else name similarity). Below MIN_MATCH it is "ambiguous"
//   and the ranking treats it as no data (neutral). Nothing is ever invented.
import type { ReputationEvidence, ValueInput } from "../ranking/value.ts";

export interface ReputationSubject {
  business_id: string;
  name: string;
  phone?: string | null;
  area?: string | null;
  simulated: boolean;
}

export type ReputationStatus = NonNullable<ValueInput["reputationStatus"]>;

export interface ReputationPort {
  peek(b: ReputationSubject): { status: ReputationStatus; evidence?: ReputationEvidence };
}

const MIN_MATCH = 0.6;
const TTL_MS = 12 * 3600_000;

/** Lowercase word tokens without business suffixes ("Harbor Table LLC" → harbor, table). */
function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter((t) => t && !["llc", "inc", "co", "the", "and", "sf", "catering"].includes(t)));
}

/** 0..1 name similarity (Jaccard on tokens). */
export function nameSimilarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  const inter = [...x].filter((t) => y.has(t)).length;
  return inter / new Set([...x, ...y]).size;
}

const digits = (p?: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);

export interface PlaceCandidate {
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
}

/** The best listing for a business, or null; pure (tests feed candidates). */
export function matchListing(b: ReputationSubject, candidates: PlaceCandidate[], now = new Date()): { status: "found" | "not_found" | "ambiguous"; evidence?: ReputationEvidence } {
  let best: { c: PlaceCandidate; conf: number } | null = null;
  for (const c of candidates) {
    const name = c.displayName?.text ?? "";
    const phoneMatch = digits(b.phone).length === 10 && [c.internationalPhoneNumber, c.nationalPhoneNumber].some((p) => digits(p) === digits(b.phone));
    const conf = phoneMatch ? 1 : nameSimilarity(b.name, name);
    if (!best || conf > best.conf) best = { c, conf };
  }
  if (!best || best.c.rating === undefined || best.c.userRatingCount === undefined) return { status: "not_found" };
  if (best.conf < MIN_MATCH) return { status: "ambiguous" };
  return {
    status: "found",
    evidence: {
      source: "Google Places", rating: best.c.rating, review_count: best.c.userRatingCount, matched_name: best.c.displayName?.text ?? b.name,
      match_confidence: Math.round(best.conf * 100) / 100, fetched_at: now.toISOString(), ...(best.c.googleMapsUri ? { url: best.c.googleMapsUri } : {}),
    },
  };
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Google Places (New) Text Search behind a cache. `apiKey` absent → every peek is "disabled". */
export function placesReputation(opts: { apiKey?: string; fetch?: Fetch; now?: () => Date; log?: (e: string, d: Record<string, unknown>) => void } = {}): ReputationPort {
  const cache = new Map<string, { at: number; status: ReputationStatus; evidence?: ReputationEvidence }>();
  const inflight = new Set<string>();
  const now = opts.now ?? (() => new Date());
  const doFetch: Fetch = opts.fetch ?? ((u, i) => fetch(u, i) as never);

  async function lookup(b: ReputationSubject) {
    inflight.add(b.business_id);
    try {
      const res = await doFetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Goog-Api-Key": opts.apiKey!, "X-Goog-FieldMask": "places.displayName,places.rating,places.userRatingCount,places.googleMapsUri,places.internationalPhoneNumber,places.nationalPhoneNumber" },
        body: JSON.stringify({ textQuery: [b.name, b.area].filter(Boolean).join(", "), pageSize: 5 }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`places ${res.status}`);
      const places = ((await res.json()) as { places?: PlaceCandidate[] }).places ?? [];
      cache.set(b.business_id, { at: now().getTime(), ...matchListing(b, places, now()) });
    } catch (e) {
      opts.log?.("reputation_lookup_failed", { business_id: b.business_id, error: (e as Error).message });
      cache.set(b.business_id, { at: now().getTime() - TTL_MS + 5 * 60_000, status: "not_found" }); // retry in ~5 min
    } finally {
      inflight.delete(b.business_id);
    }
  }

  return {
    peek(b) {
      if (b.simulated) return { status: "simulated" };
      if (!opts.apiKey) return { status: "disabled" };
      const hit = cache.get(b.business_id);
      if (hit && now().getTime() - hit.at < TTL_MS) return { status: hit.status, ...(hit.evidence ? { evidence: hit.evidence } : {}) };
      if (!inflight.has(b.business_id)) void lookup(b);
      return { status: "pending" };
    },
  };
}

// ───────────────────────────── public discovery ─────────────────────────────

/** A real business found in a public listing. Found is NOT contactable: authorization is separate. */
export interface FoundBusiness {
  name: string;
  address?: string;
  phone?: string;
  website?: string;
  maps_url?: string;
  rating?: number;
  review_count?: number;
  types: string[];
  /** 0..1: how well the listing matches the requested service and area. */
  relevance: number;
  in_area: boolean;
  source: "Google Places";
  /** Same business listed more than once (merged by phone / website / name). */
  merged_listings: number;
}

interface PlaceResult extends PlaceCandidate { formattedAddress?: string; websiteUri?: string; types?: string[]; businessStatus?: string }

const domain = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };

/** Pure: listings -> deduplicated, relevance-scored businesses (operational ones only). */
export function resolveListings(places: PlaceResult[], category: string, area: string): FoundBusiness[] {
  const want = tokens(category);
  const city = area.split(",")[0]!.trim().toLowerCase();
  const out: FoundBusiness[] = [];
  for (const p of places) {
    if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
    const name = p.displayName?.text?.trim();
    if (!name) continue;
    const phone = p.internationalPhoneNumber ?? p.nationalPhoneNumber;
    const dup = out.find((b) => (phone && b.phone && digits(b.phone) === digits(phone)) || (domain(p.websiteUri) && domain(b.website) === domain(p.websiteUri)) || nameSimilarity(b.name, name) >= 0.8);
    if (dup) { dup.merged_listings++; continue; }
    const typeWords = new Set((p.types ?? []).flatMap((t) => t.split("_")));
    const hits = [...want].filter((w) => typeWords.has(w) || tokens(name).has(w)).length;
    const inArea = !city || (p.formattedAddress ?? "").toLowerCase().includes(city);
    out.push({
      name, types: p.types ?? [], source: "Google Places", merged_listings: 1, in_area: inArea,
      relevance: Math.round(Math.min(1, (want.size ? hits / want.size : 0.5) * 0.7 + (inArea ? 0.3 : 0)) * 100) / 100,
      ...(p.formattedAddress ? { address: p.formattedAddress } : {}), ...(phone ? { phone } : {}), ...(p.websiteUri ? { website: p.websiteUri } : {}),
      ...(p.googleMapsUri ? { maps_url: p.googleMapsUri } : {}), ...(p.rating !== undefined ? { rating: p.rating } : {}), ...(p.userRatingCount !== undefined ? { review_count: p.userRatingCount } : {}),
    });
  }
  return out.sort((a, b) => b.relevance - a.relevance || (b.review_count ?? 0) - (a.review_count ?? 0));
}

/** Google Places Text Search for real businesses; null when no key is configured (never invented). */
export async function placesDiscover(opts: { apiKey?: string; fetch?: Fetch }, category: string, area: string, count = 8): Promise<FoundBusiness[] | null> {
  if (!opts.apiKey) return null;
  const doFetch: Fetch = opts.fetch ?? ((u, i) => fetch(u, i) as never);
  const res = await doFetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "content-type": "application/json", "X-Goog-Api-Key": opts.apiKey, "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.internationalPhoneNumber,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri,places.rating,places.userRatingCount,places.types,places.businessStatus" },
    body: JSON.stringify({ textQuery: `${category} in ${area}`, pageSize: Math.min(Math.max(count, 1), 20) }),
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`places search ${res.status}`);
  return resolveListings(((await res.json()) as { places?: PlaceResult[] }).places ?? [], category, area).slice(0, count);
}
