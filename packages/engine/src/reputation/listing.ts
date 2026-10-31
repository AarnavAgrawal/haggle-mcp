// Public business listings behind one interface: Amazon Location Service (Places API v2, "geo-places")
// when AWS_LOCATION_API_KEY is set, else Google Places when GOOGLE_PLACES_API_KEY is set, else off.
//
// - Found is not authorized: a published phone or email never lets Haggle call or text a business
//   (only vendors a user marked existing_relationship / business_agreed are rung); see apps/mcp.
// - Amazon terms: results fetched with IntendedUse=SingleUse may be cached briefly but not stored;
//   the GetPlace call made when a business's data IS stored (added as a vendor, put on a deal) uses
//   IntendedUse=Storage. The data provider's attribution travels with every result.
// - Amazon listings carry no ratings or reviews: ranking uses relevance, being in the area and having
//   a published contact; nothing is invented.
// - Listing text is untrusted data: only fixed fields are read; nothing in it is followed.
import { amazonHours, validTimezone, type AmazonOpeningHours } from "./hours.ts";
import { nameSimilarity, placeDetails, PlacesError, placesDiscover, type FoundBusiness, type PlacesFailure } from "./places.ts";

export type ListingFailure = PlacesFailure;
export { PlacesError as ListingError };

export type ListingFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** SingleUse: browsing (discover, a profile). Storage: the result is stored (a vendor, a deal). */
export type IntendedUse = "SingleUse" | "Storage";

export interface ListingProvider {
  kind: "amazon" | "google";
  source: FoundBusiness["source"];
  attribution: string;
  /** Does this provider issue (and can it look up) this business_ref? */
  owns(ref: string): boolean;
  /** Ranked businesses for a service in an area. Throws ListingError with a code an agent can act on. */
  discover(category: string, area: string, count: number): Promise<FoundBusiness[]>;
  /** One business, fresh, by its business_ref; null when unknown. */
  details(ref: string, opts?: { intendedUse?: IntendedUse; category?: string; area?: string }): Promise<FoundBusiness | null>;
}

// ───────────────────────────── Google Places (kept as a provider) ─────────────────────────────

export function googlePlacesProvider(o: { apiKey: string; fetch?: ListingFetch; now?: () => Date }): ListingProvider {
  const opts = { apiKey: o.apiKey, ...(o.fetch ? { fetch: o.fetch as never } : {}), ...(o.now ? { now: o.now } : {}) };
  return {
    kind: "google", source: "Google Places", attribution: "Google Maps",
    owns: (ref) => /^place:/.test(ref),
    discover: async (category, area, count) => (await placesDiscover(opts, category, area, count)) ?? [],
    details: (ref, d = {}) => placeDetails(opts, ref.replace(/^place:/, ""), d.category ?? "", d.area ?? ""),
  };
}

// ───────────────────────────── Amazon Location Service ─────────────────────────────

interface AwsContact { Label?: string; Value?: string; Categories?: { Id?: string }[] }
interface AwsCategory { Id?: string; Name?: string; LocalizedName?: string; Primary?: boolean }
/** The fields Haggle reads from a SearchText result item or a GetPlace response. */
export interface AwsPlace {
  PlaceId?: string;
  PlaceType?: string;
  Title?: string;
  Address?: { Label?: string; Locality?: string; District?: string; Region?: { Name?: string; Code?: string } };
  Position?: number[];
  Distance?: number;
  Categories?: AwsCategory[];
  Contacts?: { Phones?: AwsContact[]; Emails?: AwsContact[]; Websites?: AwsContact[] };
  OpeningHours?: AmazonOpeningHours[];
  TimeZone?: { Name?: string; Offset?: string; OffsetSeconds?: number };
}

export const AMAZON_ATTRIBUTION = "Amazon Location Service (data © HERE)";
const AMAZON_SOURCE = "Amazon Location Service" as const;
/** In the area: the listing's address names the city, or it is within this distance of the area's centre. */
const IN_AREA_METERS = 25_000;
const STOP = new Set(["llc", "inc", "co", "the", "and", "sf", "a", "an", "of", "for", "in", "services", "service"]);
const words = (s: string) => new Set(s.toLowerCase().replace(/&/g, " and ").split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)));
/** "plumber" matches "Plumbing": compare the first five letters of each word. */
const stem = (w: string) => w.slice(0, 5);
const digits = (p?: string | null) => (p ?? "").replace(/\D/g, "").slice(-10);
const domain = (u?: string) => { try { return u ? new URL(u).hostname.replace(/^www\./, "") : ""; } catch { return ""; } };

/** The listing's contacts for this place: entries tagged with its primary category, or untagged, first. */
function contactsFor(list: AwsContact[] | undefined, primary?: string): string[] {
  const all = (list ?? []).filter((c) => typeof c.Value === "string" && c.Value.trim());
  const mine = all.filter((c) => !c.Categories?.length || (primary && c.Categories.some((x) => x.Id === primary)));
  return (mine.length ? mine : all).map((c) => c.Value!.trim());
}

function website(raw?: string): string | undefined {
  if (!raw) return undefined;
  const u = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try { const x = new URL(u); return /^https?:$/.test(x.protocol) && x.hostname.includes(".") ? x.toString() : undefined; } catch { return undefined; }
}

/** Pure: Amazon Location places → deduplicated, ranked businesses (points of interest only; no ratings exist). */
export function resolveAmazonPlaces(places: AwsPlace[], category: string, area: string, now = new Date()): FoundBusiness[] {
  const want = [...words(category)].map(stem);
  const city = area.split(",")[0]!.trim().toLowerCase();
  const out: FoundBusiness[] = [];
  for (const p of places) {
    if (p.PlaceType && p.PlaceType !== "PointOfInterest") continue;
    const name = p.Title?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120);
    if (!name || !p.PlaceId) continue;
    const primary = (p.Categories ?? []).find((c) => c.Primary) ?? p.Categories?.[0];
    const phone = contactsFor(p.Contacts?.Phones, primary?.Id).find((x) => /^\+?[\d\s().-]{7,20}$/.test(x));
    const site = contactsFor(p.Contacts?.Websites, primary?.Id).map(website).find(Boolean);
    const emails = [...new Set(contactsFor(p.Contacts?.Emails, primary?.Id).map((e) => e.toLowerCase()).filter((e) => /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/.test(e)))].slice(0, 3);
    const dup = out.find((b) => b.place_id === p.PlaceId || (phone && b.phone && digits(b.phone) === digits(phone)) || (domain(site) && domain(b.website) === domain(site)) || nameSimilarity(b.name, name) >= 0.8);
    if (dup) { dup.merged_listings++; continue; }
    const catWords = new Set((p.Categories ?? []).flatMap((c) => [...words(`${c.Name ?? ""} ${c.LocalizedName ?? ""} ${(c.Id ?? "").replace(/_/g, " ")}`)]).map(stem));
    const nameWords = new Set([...words(name)].map(stem));
    const hits = want.filter((w) => catWords.has(w) || nameWords.has(w)).length;
    const label = `${p.Address?.Label ?? ""} ${p.Address?.Locality ?? ""}`.toLowerCase();
    const inArea = !city || label.includes(city) || (typeof p.Distance === "number" && p.Distance <= IN_AREA_METERS);
    const relevance = Math.round(Math.min(1, (want.length ? hits / want.length : 0.5) * 0.7 + (inArea ? 0.3 : 0)) * 100) / 100;
    const reach = phone || emails.length || site ? 1 : 0;
    const tz = validTimezone(p.TimeZone?.Name) ? p.TimeZone!.Name! : undefined;
    const hours = amazonHours(p.OpeningHours, tz ?? null, primary?.Id) ?? undefined;
    const score = Math.round((0.75 * relevance + 0.2 * reach + 0.05 * (hours ? 1 : 0)) * 100) / 100;
    const reasons = [
      hits ? `matches "${category}" (${hits}/${want.length || 1} terms in its listing)` : `weak match for "${category}"`,
      inArea ? `in ${area.split(",")[0]}` : `outside ${area.split(",")[0]}`,
      reach ? `published ${[phone && "phone", emails.length && "email", site && "website"].filter(Boolean).join(" + ")}` : "no published phone, email or website",
      "no public rating (this listing source has none)",
    ];
    out.push({
      business_ref: `aws:${p.PlaceId}`, place_id: p.PlaceId, name, types: (p.Categories ?? []).map((c) => c.Id ?? "").filter(Boolean),
      source: AMAZON_SOURCE, attribution: AMAZON_ATTRIBUTION, fetched_at: now.toISOString(), merged_listings: 1, in_area: inArea, relevance, score, rank_reasons: reasons,
      ...(p.Address?.Label ? { address: p.Address.Label } : {}), ...(phone ? { phone } : {}), ...(site ? { website: site } : {}),
      ...(primary?.Id ? { primary_type: primary.Id } : {}), ...(emails.length ? { listing_emails: emails } : {}),
      ...(hours ? { hours } : {}), ...(tz ? { timezone: tz } : {}),
    });
  }
  const dist = (b: FoundBusiness) => places.find((p) => p.PlaceId === b.place_id)?.Distance ?? Number.MAX_SAFE_INTEGER;
  return out.sort((a, b) => b.score - a.score || dist(a) - dist(b) || a.name.localeCompare(b.name));
}

function awsFailure(status: number): PlacesError {
  if (status === 429) return new PlacesError("rate_limited", "Amazon Location rate limit reached; retry in a minute.");
  if (status === 401 || status === 403) return new PlacesError("key_rejected", `Amazon Location rejected the API key (HTTP ${status}); the operator must check AWS_LOCATION_API_KEY, its region (AWS_LOCATION_REGION) and that it allows geo-places:SearchText, GetPlace and Geocode.`);
  if (status === 400) return new PlacesError("unavailable", "Amazon Location refused the search (HTTP 400); try a shorter category or area.");
  return new PlacesError("unavailable", `Amazon Location is unavailable (HTTP ${status}); retry later.`);
}

const PLACE_ID_RE = /^[A-Za-z0-9_=+/-]{8,500}$/;

/** Amazon Location Places v2 with an API key (plain HTTPS; no AWS SDK, no request signing). */
export function amazonLocationProvider(o: { apiKey: string; region?: string; fetch?: ListingFetch; now?: () => Date }): ListingProvider {
  const region = /^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region ?? "") ? o.region! : "us-east-1";
  const base = `https://places.geo.${region}.amazonaws.com/v2`;
  const key = encodeURIComponent(o.apiKey);
  const doFetch: ListingFetch = o.fetch ?? ((u, i) => fetch(u, i) as never);
  const now = o.now ?? (() => new Date());
  // Geocoded areas, briefly (SingleUse results may be cached short-term, never stored).
  const areas = new Map<string, { at: number; pos: number[] | null }>();

  async function call(path: string, init: { method: "GET" | "POST"; body?: unknown }): Promise<unknown> {
    let res;
    try {
      res = await doFetch(`${base}${path}${path.includes("?") ? "&" : "?"}key=${key}`, {
        method: init.method, headers: init.body ? { "content-type": "application/json" } : {}, ...(init.body ? { body: JSON.stringify(init.body) } : {}), signal: AbortSignal.timeout(6000),
      });
    } catch (e) { throw new PlacesError("unavailable", `Amazon Location unreachable: ${(e as Error).message.slice(0, 80)}`); }
    if (!res.ok) throw awsFailure(res.status);
    return res.json();
  }

  async function position(area: string): Promise<number[] | null> {
    const k = area.trim().toLowerCase();
    const hit = areas.get(k);
    if (hit && now().getTime() - hit.at < 3600_000) return hit.pos;
    const r = (await call("/geocode", { method: "POST", body: { QueryText: area.slice(0, 200), MaxResults: 1, IntendedUse: "SingleUse" } })) as { ResultItems?: { Position?: number[] }[] };
    const pos = r.ResultItems?.[0]?.Position;
    const ok = Array.isArray(pos) && pos.length === 2 && pos.every((n) => typeof n === "number" && Number.isFinite(n)) ? pos : null;
    if (areas.size > 500) areas.clear();
    areas.set(k, { at: now().getTime(), pos: ok });
    return ok;
  }

  return {
    kind: "amazon", source: AMAZON_SOURCE, attribution: AMAZON_ATTRIBUTION,
    owns: (ref) => /^aws:/.test(ref),
    async discover(category, area, count) {
      const pos = await position(area);
      if (!pos) throw new PlacesError("area_not_found", `Amazon Location couldn't find "${area.slice(0, 80)}"; pass a city and state (e.g. "Oakland, CA") or a street address.`);
      const r = (await call("/search-text", {
        method: "POST",
        body: { QueryText: category.slice(0, 200), BiasPosition: pos, MaxResults: Math.min(Math.max(count * 2, 5), 20), AdditionalFeatures: ["Contact", "TimeZone"], IntendedUse: "SingleUse" },
      })) as { ResultItems?: AwsPlace[] };
      return resolveAmazonPlaces(r.ResultItems ?? [], category, area, now()).slice(0, count);
    },
    async details(ref, d = {}) {
      const id = ref.replace(/^aws:/, "");
      if (!PLACE_ID_RE.test(id)) return null;
      const q = `additional-features=Contact&additional-features=TimeZone&intended-use=${d.intendedUse ?? "SingleUse"}`;
      let p: AwsPlace;
      try {
        p = (await call(`/place/${encodeURIComponent(id)}?${q}`, { method: "GET" })) as AwsPlace;
      } catch (e) {
        if (e instanceof PlacesError && /HTTP 404/.test(e.message)) return null;
        throw e;
      }
      return resolveAmazonPlaces([{ ...p, PlaceId: p.PlaceId ?? id }], d.category ?? "", d.area ?? "", now())[0] ?? null;
    },
  };
}

// ───────────────────────────── selection ─────────────────────────────

/** Amazon Location when AWS_LOCATION_API_KEY is set, else Google Places when GOOGLE_PLACES_API_KEY is, else null (off). */
export function listingProviderFromEnv(env: { AWS_LOCATION_API_KEY?: string; AWS_LOCATION_REGION?: string; GOOGLE_PLACES_API_KEY?: string }, o: { fetch?: ListingFetch; now?: () => Date } = {}): ListingProvider | null {
  const aws = env.AWS_LOCATION_API_KEY?.trim();
  if (aws) return amazonLocationProvider({ apiKey: aws, ...(env.AWS_LOCATION_REGION?.trim() ? { region: env.AWS_LOCATION_REGION.trim() } : {}), ...o });
  const google = env.GOOGLE_PLACES_API_KEY?.trim();
  if (google) return googlePlacesProvider({ apiKey: google, ...o });
  return null;
}

/** Which listing variables to set, for "discovery is off" messages. */
export const LISTING_KEYS_HINT = "AWS_LOCATION_API_KEY (Amazon Location Service) or GOOGLE_PLACES_API_KEY";
