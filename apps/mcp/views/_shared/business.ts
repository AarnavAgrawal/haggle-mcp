/**
 * Pure display helpers for businesses (discover's results card and the business profile): contact
 * state badges, ratings, evidence grouping, safe external links and the "get quotes" prompt. No React,
 * no CSS, so tests run them without a DOM (tests/businessList.test.ts).
 *
 * Listing and website data is third-party and untrusted: it is shown as text, links open only on the
 * human's click and only for http(s) URLs, and nothing here ever feeds instructions to the model.
 */

export type ContactState = "discovered" | "contact_found" | "authorized" | "verified_responsive";
export type BadgeTone = "muted" | "warn" | "win" | "info";

const CONTACT_STATE: Record<ContactState, { label: string; tone: BadgeTone; hint: string }> = {
  discovered: { label: "Not contactable", tone: "muted", hint: "Haggle found this business but has no way to reach it." },
  contact_found: { label: "Contact found · not authorized", tone: "warn", hint: "A published phone or email isn't permission: the operator hasn't authorized contacting it." },
  authorized: { label: "Haggle may contact", tone: "win", hint: "Authorized on this server and the channel can send." },
  verified_responsive: { label: "Has replied before", tone: "info", hint: "Authorized, and it has replied to Haggle before." },
};

/** Badge words and tone for a contact state; an unknown state reads as words, never as "authorized". */
export function contactBadge(state: string | undefined): { label: string; tone: BadgeTone; hint: string } {
  if (state && state in CONTACT_STATE) return CONTACT_STATE[state as ContactState];
  const words = (state ?? "").replace(/_/g, " ").trim();
  return { label: words ? words[0]!.toUpperCase() + words.slice(1) : "Contact unknown", tone: "muted", hint: "" };
}

/** True when Haggle may actually send to it (authorized or verified responsive). */
export const isContactable = (state: string | undefined) => state === "authorized" || state === "verified_responsive";

/** "4.7" with one decimal; undefined when there is no rating. */
export function ratingValue(rating: number | undefined | null): string | undefined {
  if (rating === undefined || rating === null || !Number.isFinite(rating)) return undefined;
  return (Math.round(rating * 10) / 10).toFixed(1);
}

/** "318 reviews" / "1 review" / "1,204 reviews". */
export function reviewsText(count: number | undefined | null): string {
  const n = count ?? 0;
  return `${n.toLocaleString("en-US")} review${n === 1 ? "" : "s"}`;
}

/** Filled share (0–100) of a five-star bar, in half stars. */
export function starPercent(rating: number | undefined | null): number {
  if (rating === undefined || rating === null || !Number.isFinite(rating)) return 0;
  return (Math.round(Math.min(5, Math.max(0, rating)) * 2) / 2 / 5) * 100;
}

/** Only http(s) links are offered to the human; anything else (javascript:, data:, mailto:) is dropped. */
export function safeUrl(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** "https://www.aceplumbing.example/menu" → "aceplumbing.example". */
export function hostOf(url: string | undefined | null): string | undefined {
  const safe = safeUrl(url);
  if (!safe) return undefined;
  return new URL(safe).hostname.replace(/^www\./, "");
}

/** An evidence source as short words: a URL becomes its host, anything else is kept. */
export function sourceText(source: string): string {
  return hostOf(source) ?? source;
}

/** "2026-10-18T…" → "Oct 18, 2026"; the input when it isn't a date. */
export function shortDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export type EvidenceItem = {
  kind: string;
  statement: string;
  source: string;
  observed_at: string;
  freshness?: string;
  confidence?: number;
  caveat?: string;
};

export type EvidenceGroupKey = "verified" | "listing" | "claims" | "estimates" | "other";

const GROUP_TITLE: Record<EvidenceGroupKey, string> = {
  verified: "Verified by Haggle",
  listing: "Public listing & reviews",
  claims: "The business's own website (claims)",
  estimates: "Haggle's estimates",
  other: "Other",
};

const GROUP_OF: Record<string, EvidenceGroupKey> = {
  verified: "verified",
  third_party_listing: "listing",
  third_party_reputation: "listing",
  listing: "listing",
  reviews: "listing",
  vendor_claim: "claims",
  inferred_estimate: "estimates",
  estimate: "estimates",
};

const GROUP_ORDER: EvidenceGroupKey[] = ["verified", "listing", "claims", "estimates", "other"];

/** Evidence grouped by kind in a fixed order (verified first); empty groups are left out. */
export function evidenceGroups(evidence: EvidenceItem[] | undefined): { key: EvidenceGroupKey; title: string; items: EvidenceItem[] }[] {
  const by = new Map<EvidenceGroupKey, EvidenceItem[]>();
  for (const e of evidence ?? []) {
    const k = GROUP_OF[e.kind] ?? "other";
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  return GROUP_ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, title: GROUP_TITLE[k], items: by.get(k)! }));
}

/** A learned profile field with nothing learned yet ("Unknown until the business quotes", "Unknown: …"). */
export const isUnknownField = (v: string | undefined) => !v || /^unknown\b/i.test(v.trim());

export type FoundRow = { name: string; business_ref: string; contact_state: string };
export type VendorRow = { name: string; ready: boolean };

/**
 * The "Get quotes from these" message: the found businesses (or, with none, the ready demo vendors),
 * asking the assistant to check who Haggle may contact before anything is sent.
 */
export function quotesPrompt(found: FoundRow[], vendors: VendorRow[], category?: string): string {
  const what = category ? `${category} ` : "";
  if (found.length) {
    const names = found.map((f) => f.name);
    const list = names.map((n) => `'${n.replace(/'/g, "’")}'`).join(", ");
    return `Get ${what}quotes from these businesses with Haggle: ${names.join(", ")}. First run deal with businesses=[${list}] and dry_run=true to check which ones Haggle may contact, and tell me before anything is sent.`;
  }
  const ready = vendors.filter((v) => v.ready).map((v) => v.name);
  return ready.length
    ? `Get ${what}quotes with Haggle from my ready vendors: ${ready.join(", ")}. Ask me for anything you need (quantity, date, budget) before calling deal.`
    : "Haggle has no ready vendors. Show me what's blocking them.";
}

/**
 * The business's website for the profile's link: an explicit field when the server sends one, else the
 * website the evidence cites (the page Haggle read, or the URL the listing publishes). http(s) only.
 */
export function websiteFrom(p: { website?: string; public_listing?: { website?: string }; evidence?: EvidenceItem[] }): string | undefined {
  const direct = safeUrl(p.website) ?? safeUrl(p.public_listing?.website);
  if (direct) return direct;
  for (const e of p.evidence ?? []) {
    if (e.kind === "vendor_claim" && safeUrl(e.source)) return safeUrl(e.source);
  }
  for (const e of p.evidence ?? []) {
    const m = e.kind === "third_party_listing" ? /a website \((https?:\/\/[^\s)]+)\)/.exec(e.statement) : null;
    if (m && safeUrl(m[1])) return safeUrl(m[1]);
  }
  return undefined;
}
