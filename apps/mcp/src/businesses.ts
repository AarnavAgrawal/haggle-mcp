// One business contract for configured demo vendors and real businesses found in public listings:
// the same names/refs select them, the same contact states describe how (and whether) Haggle may reach
// them, and the same evidence model says what is known, from where, and how firmly.
//
// Found is not authorized. A phone or email published on a listing or website is a "contact found";
// Haggle may use it only when the operator has authorized it (recipient allowlist) and the channel can
// send. Selection is exact and fails closed: an unknown, ambiguous or unreachable choice starts nothing
// and never falls back to other businesses.
import type { Channel, Profile } from "@haggle/core";
import { businessIdForContact, DEFAULT_WORKSPACE_ID, normalizeBusinessName, placeDetails, PlacesError, websiteEvidence, type ContactLearning, type FoundBusiness, type WebsiteEvidence } from "@haggle/engine";
import type { Runtime } from "./runtime.ts";
import { businessRef, findVendors, findWorkspaceVendors, workspaceVendorList, workspaceVendorReadiness, type ChannelStatus, type RosterEntry, type WorkspaceVendor } from "./vendors.ts";

// ───────────────────────────── categories ─────────────────────────────

const CATEGORIES: [string, RegExp][] = [
  ["catering", /\b(cater\w*|lunch\w*|dinner\w*|breakfast|brunch|meals?|food|buffet|snacks?|pizza|tacos?|sandwich\w*|bento|boxed)\b/i],
  ["photography", /\b(photograph\w*|videograph\w*|headshots?)\b/i],
  ["entertainment", /\b(dj|band|musicians?|entertain\w*)\b/i],
  ["rentals", /\b(rentals?|rent|tents?|furniture)\b/i],
  ["printing", /\b(print\w*|flyers?|banners?|posters?|stickers?|signage)\b/i],
  ["moving", /\b(movers?|moving|move|relocat\w*)\b/i],
  ["cleaning", /\b(clean\w*|janitor\w*)\b/i],
  ["plumbing", /\b(plumb\w*|leak\w*|pipes?|drains?|toilets?|water heater)\b/i],
  ["electrical", /\b(electric\w*|wiring|outlets?)\b/i],
  ["repairs", /\b(repairs?|handyman|fix\w*|maintenance)\b/i],
];

/**
 * "Drop-off catering for 25" → "catering"; "fix a leaking pipe" → "plumbing"; else the last word.
 * The service named FIRST wins ("cleaning crew for our catered dinner" is cleaning, "repair of a pizza
 * oven" is repairs, "catering for a cleaning company" is catering), and a specific trade beats the
 * generic "repairs" ("fix a leaking pipe" is plumbing): food words elsewhere never pull in caterers.
 */
/** The category a request names explicitly ("fix a leaking pipe" → "plumbing"), or null when it names none of them. */
export function knownCategory(what: string): string | null {
  return CATEGORIES.some(([, re]) => re.test(what)) ? requestCategory(what) : null;
}

export function requestCategory(what: string): string {
  const hits = CATEGORIES.map(([c, re]) => ({ c, at: re.exec(what)?.index ?? -1 })).filter((h) => h.at >= 0).sort((a, b) => a.at - b.at);
  const first = hits[0];
  if (!first) return what.trim().toLowerCase().split(/\s+/).at(-1) ?? what.toLowerCase();
  // "fix a leaking pipe": a named trade refines the generic repair; a food word ("pizza oven") never does.
  const trade = first.c === "repairs" ? hits.find((h) => h.c !== "repairs" && h.c !== "catering") : undefined;
  return (trade ?? first).c;
}

// ───────────────────────────── discovered businesses ─────────────────────────────

export interface Discovered extends FoundBusiness {
  category: string;
  area: string;
  website_evidence?: WebsiteEvidence;
}

/**
 * Businesses found by recent discover calls, so an agent can select them by name or ref. In memory
 * only and short-lived (Google Maps Platform terms: Places content isn't stored; the place id, kept
 * in the ref, can be re-fetched fresh with Place Details).
 */
export class DiscoveryRegistry {
  private readonly items = new Map<string, { b: Discovered; at: number }>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(ttlMs = 30 * 60_000, now = () => Date.now()) { this.ttlMs = ttlMs; this.now = now; }
  remember(list: Discovered[]): void {
    for (const b of list) {
      const prev = this.items.get(b.business_ref)?.b;
      this.items.set(b.business_ref, { b: { ...b, ...(prev?.website_evidence && !b.website_evidence ? { website_evidence: prev.website_evidence } : {}) }, at: this.now() });
    }
  }
  private fresh(): Discovered[] {
    for (const [k, v] of this.items) if (this.now() - v.at > this.ttlMs) this.items.delete(k);
    return [...this.items.values()].map((v) => v.b);
  }
  get(ref: string): Discovered | null {
    return this.fresh().find((b) => b.business_ref === ref || b.place_id === ref) ?? null;
  }
  /** Exact (normalized) name first, else a unique whole-word partial name. */
  find(name: string): Discovered[] {
    const c = normalizeBusinessName(name);
    const all = this.fresh();
    const exact = all.filter((b) => normalizeBusinessName(b.name) === c);
    if (exact.length) return exact;
    const words = c.split(" ").filter(Boolean);
    return words.length ? all.filter((b) => { const n = normalizeBusinessName(b.name).split(" "); return words.every((w) => n.includes(w)); }) : [];
  }
}

const registries = new Map<string, DiscoveryRegistry>();
/** Each workspace's own discover results: one tenant's searches are never selectable (or visible) by another. */
export function discoveredFor(workspaceId: string): DiscoveryRegistry {
  let r = registries.get(workspaceId);
  if (!r) registries.set(workspaceId, (r = new DiscoveryRegistry()));
  return r;
}
/** The default workspace's registry (single-tenant servers). */
export const discovered = discoveredFor(DEFAULT_WORKSPACE_ID);

/** Website evidence for a discovered business (fetched once per registry lifetime, never throws). */
export async function withWebsite(b: Discovered, rt: Runtime, reg: DiscoveryRegistry = discovered): Promise<Discovered> {
  if (!b.website || b.website_evidence) return b;
  const ev = await websiteEvidence(b.website, rt.webFetch ? { fetch: rt.webFetch.fetch, resolve: rt.webFetch.resolve } : {});
  const next = { ...b, website_evidence: ev };
  reg.remember([next]);
  return next;
}

// ───────────────────────────── contact routes and states ─────────────────────────────

/** Discovered → contact found → authorized (allowlisted and the channel can send) → verified responsive. */
export type ContactState = "discovered" | "contact_found" | "authorized" | "verified_responsive";

export interface Route {
  channel: Channel;
  /** Masked phone or email (full contacts stay server-side). */
  contact: string;
  found_via: "operator configuration" | "Google Places listing" | "business website";
  authorized: boolean;
  ready: boolean;
  blocker?: string;
}

export interface ContactStatus {
  state: ContactState;
  routes: Route[];
  /** Haggle has seen this business reply before (on any id it had). */
  responded_before: boolean;
  summary: string;
}

const mask = (c: string) => (c.includes("@") ? c : `${c.slice(0, 2)}•••${c.slice(-2)}`);

/** "+1 415-555-0101" / "(415) 555-0101" → "+14155550101" (US default); null if not a phone. */
export function e164(p?: string | null): string | null {
  const d = (p ?? "").replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{6,14}$/.test(d)) return d;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  return null;
}

export function routeFor(channel: "email" | "phone", contact: string, found_via: Route["found_via"], canContact: (c: { email?: string; phone?: string }) => boolean, ch: ChannelStatus): Route {
  const base = { channel, contact: mask(contact), found_via };
  if (!canContact(channel === "email" ? { email: contact } : { phone: contact })) {
    return { ...base, authorized: false, ready: false, blocker: `${channel === "email" ? "email" : "phone number"} found (${found_via}), but this server isn't authorized to contact it: finding a contact isn't permission. The operator adds it to HAGGLE_ALLOWED_RECIPIENTS once the business agrees.` };
  }
  if (channel === "email") return ch.email ? { ...base, authorized: true, ready: true } : { ...base, authorized: true, ready: false, blocker: "email outreach is off on this server" };
  if (!ch.phone) return { ...base, authorized: true, ready: false, blocker: "Voice AI calls are off on this server" };
  if (ch.callsViaSharedLine && !ch.connected?.has(contact)) return { ...base, authorized: true, ready: false, blocker: "calls go over the shared iMessage line and this number hasn't connected to it" };
  return { ...base, authorized: true, ready: true };
}

export function contactStatus(routes: Route[], learning: ContactLearning | null): ContactStatus {
  const responded = Object.values(learning?.channels ?? {}).some((r) => (r?.replied_jobs ?? 0) > 0);
  const ready = routes.find((r) => r.ready);
  const state: ContactState = !routes.length ? "discovered" : !ready ? "contact_found" : responded ? "verified_responsive" : "authorized";
  const summary =
    state === "discovered" ? "Found in a public listing, but no phone or email is published: Haggle has no way to reach it."
    : state === "contact_found" ? `Contact details found, not usable: ${routes[0]!.blocker}`
    : state === "authorized" ? `Haggle may contact it by ${ready!.channel === "phone" ? "Voice AI call" : ready!.channel}; it hasn't replied to Haggle before.`
    : `Haggle may contact it by ${ready!.channel === "phone" ? "Voice AI call" : ready!.channel}, and it has replied to Haggle before.`;
  return { state, routes, responded_before: responded, summary };
}

export function vendorRoutes(v: RosterEntry): Route[] {
  const contact = v.email ?? v.phone ?? v.a2a_card_url;
  if (!contact) return [];
  return [{ channel: v.channel, contact: mask(contact), found_via: "operator configuration", authorized: true, ready: v.ready, ...(v.blocker ? { blocker: v.blocker } : {}) }];
}

export function discoveredRoutes(b: Discovered, rt: Runtime, ch: ChannelStatus): { routes: Route[]; contacts: { email?: string; phone?: string }[] } {
  const can = (c: { email?: string; phone?: string }) => rt.engine.canContact(c);
  const phone = e164(b.phone);
  const emails = b.website_evidence?.emails ?? [];
  const contacts = [...emails.map((email) => ({ email })), ...(phone ? [{ phone }] : [])];
  const routes = [...emails.map((e) => routeFor("email", e, "business website", can, ch)), ...(phone ? [routeFor("phone", phone, "Google Places listing", can, ch)] : [])];
  return { routes, contacts };
}

/** Where learning comes from: the workspace-scoped engine for anything an agent sees (only its own deals). */
export interface LearningSource {
  contactLearning(businessId: string, aliases?: string[]): Promise<ContactLearning>;
  businessAliases(b: { business_id: string; name: string; email?: string | null; phone?: string | null }): Promise<string[]>;
}

/** What Haggle observed reaching a business (all ids it had), or null. */
export async function learningFor(src: LearningSource, name: string, c: { email?: string | null; phone?: string | null }): Promise<ContactLearning | null> {
  if (!c.email && !c.phone) return null;
  const id = businessIdForContact({ email: c.email ?? null, phone: c.email ? null : c.phone ?? null }, name);
  return src.contactLearning(id, await src.businessAliases({ business_id: id, name, email: c.email ?? null, phone: c.phone ?? null })).catch(() => null);
}

/** The route of a vendor the operator authorized for this workspace. */
export function workspaceVendorRoutes(v: WorkspaceVendor, ch: ChannelStatus): Route[] {
  const contact = v.channel === "email" ? v.email : v.phone;
  if (!contact) return [];
  const r = workspaceVendorReadiness(v, ch);
  return [{ channel: v.channel, contact: mask(contact), found_via: "operator configuration", authorized: true, ready: r.ready, ...(r.blocker ? { blocker: r.blocker } : {}) }];
}

// ───────────────────────────── selection ─────────────────────────────

export type Selected =
  | { kind: "vendor"; name: string; business_ref: string; vendor: RosterEntry; status: ContactStatus; send?: { email?: string; phone?: string; a2a_card_url?: string; channel: Channel } }
  /** A vendor the operator authorized for this workspace (workspace-admin add-vendor), with its recorded consent. */
  | { kind: "workspace_vendor"; name: string; business_ref: string; vendor: WorkspaceVendor; status: ContactStatus; send?: { email?: string; phone?: string; channel: Channel } }
  | { kind: "discovered"; name: string; business_ref: string; found: Discovered; status: ContactStatus; send?: { email?: string; phone?: string; channel: Channel } };

export type Selection =
  | { ok: true; selected: Selected[] }
  | { ok: false; code: "unknown_business" | "ambiguous_business"; message: string; fix: string; details: { ref: string; candidates?: string[] }[] };

/** The connection's workspace: its operator-authorized vendors, and learning from its own deals only. */
export interface SelectionScope {
  vendors: { name: string; contact: string; channel?: Channel | null }[];
  learning: LearningSource;
  /** This workspace's discover results (default: the default workspace's). */
  discovered?: DiscoveryRegistry;
}

/**
 * Resolve the businesses an agent named: this workspace's operator-authorized vendors first (by
 * name or business_ref, case- and space-insensitive), then configured vendors (name, business_ref,
 * id), then businesses from recent discover calls (name or "place:<id>", re-fetched by id when
 * needed). Identity problems (unknown, ambiguous) fail the whole selection; reachability is reported
 * per business in `status` for the caller to enforce. One entry per ref, in order (callers dedupe).
 * The agent never supplies a contact here: a name only ever resolves to what the operator configured.
 */
export async function resolveSelection(refs: string[], rt: Runtime, scope?: SelectionScope): Promise<Selection> {
  const roster = await rt.roster();
  const ch = await rt.channels();
  const learning = scope?.learning ?? rt.engine;
  const mine = workspaceVendorList(scope?.vendors ?? []);
  const reg = scope?.discovered ?? discovered;
  const out: Selected[] = [];
  const unknown: { ref: string }[] = [];
  const ambiguous: { ref: string; candidates: string[] }[] = [];
  for (const ref of refs) {
    const own = findWorkspaceVendors(ref, mine);
    if (own.length > 1) { ambiguous.push({ ref, candidates: own.map((v) => v.name) }); continue; }
    if (own.length === 1) {
      const v = own[0]!;
      const routes = workspaceVendorRoutes(v, ch);
      const status = contactStatus(routes, await learningFor(learning, v.name, { email: v.email ?? null, phone: v.phone ?? null }));
      out.push({ kind: "workspace_vendor", name: v.name, business_ref: v.business_ref, vendor: v, status,
        ...(routes[0]?.ready ? { send: { channel: v.channel, ...(v.email ? { email: v.email } : {}), ...(v.phone ? { phone: v.phone } : {}) } } : {}) });
      continue;
    }
    const vendors = findVendors(ref, roster);
    if (vendors.length > 1) { ambiguous.push({ ref, candidates: vendors.map((v) => v.name) }); continue; }
    if (vendors.length === 1) {
      const v = vendors[0]!;
      const learned = await learningFor(learning, v.name, { email: v.email ?? null, phone: v.phone ?? null });
      out.push({ kind: "vendor", name: v.name, business_ref: businessRef(v), vendor: v, status: contactStatus(vendorRoutes(v), learned),
        ...(v.ready ? { send: { channel: v.channel, ...(v.email ? { email: v.email } : {}), ...(v.phone ? { phone: v.phone } : {}), ...(v.a2a_card_url ? { a2a_card_url: v.a2a_card_url } : {}) } } : {}) });
      continue;
    }
    let hits: Discovered[] = [];
    if (/^place:/.test(ref)) {
      const known = reg.get(ref);
      if (known) hits = [known];
      else if (rt.placesKey) {
        const fresh = await placeDetails({ apiKey: rt.placesKey, ...(rt.placesFetch ? { fetch: rt.placesFetch } : {}) }, ref.slice(6)).catch((e) => { if (e instanceof PlacesError) return null; throw e; });
        if (fresh) { const d = { ...fresh, category: "", area: "" }; reg.remember([d]); hits = [d]; }
      }
    } else hits = reg.find(ref);
    if (hits.length > 1) { ambiguous.push({ ref, candidates: hits.map((h) => `${h.name} (${h.address ?? h.business_ref})`) }); continue; }
    if (!hits.length) { unknown.push({ ref }); continue; }
    const b = await withWebsite(hits[0]!, rt, reg);
    const { routes, contacts } = discoveredRoutes(b, rt, ch);
    const status = contactStatus(routes, await learningFor(learning, b.name, { email: contacts.find((c) => c.email)?.email ?? null, phone: contacts.find((c) => c.phone)?.phone ?? null }));
    const i = routes.findIndex((r) => r.ready);
    out.push({ kind: "discovered", name: b.name, business_ref: b.business_ref, found: b, status, ...(i >= 0 ? { send: { channel: routes[i]!.channel, ...contacts[i]! } } : {}) });
  }
  if (unknown.length) {
    const names = [...mine.map((v) => `${v.name} (${v.business_ref}, authorized for this workspace)`), ...roster.map((r) => `${r.name} (${businessRef(r)})`)].join(", ") || "none";
    return {
      ok: false, code: "unknown_business", message: `Haggle doesn't know ${unknown.map((u) => `"${u.ref}"`).join(", ")}. Nothing was sent.`,
      fix: `Ask the user which business they meant. Configured vendors: ${names}.${rt.placesKey ? " To find real businesses, call discover(category, area) first, then select them by name." : " Real-business discovery is off on this server (no GOOGLE_PLACES_API_KEY)."}`,
      details: unknown,
    };
  }
  if (ambiguous.length) return { ok: false, code: "ambiguous_business", message: `${ambiguous.map((a) => `"${a.ref}" could be ${a.candidates.join(" or ")}`).join("; ")}. Nothing was sent.`, fix: "Ask the user which one they meant, then pass that exact name (or its business_ref).", details: ambiguous };
  return { ok: true, selected: out };
}

// ───────────────────────────── evidence ─────────────────────────────

/**
 * verified: Haggle saw it itself (a reply, a quote it received, an operator-configured route).
 * third_party_listing / third_party_reputation: a public listing's facts and ratings.
 * vendor_claim: what the business publishes about itself (website); not confirmed to Haggle.
 * inferred_estimate: Haggle's own arithmetic from observations.
 */
export interface EvidenceItem {
  kind: "verified" | "third_party_listing" | "third_party_reputation" | "vendor_claim" | "inferred_estimate";
  statement: string;
  source: string;
  observed_at: string;
  freshness: "fresh" | "recent" | "stale";
  confidence: number;
  caveat?: string;
}

export function freshness(at: string, now = Date.now()): EvidenceItem["freshness"] {
  const age = now - Date.parse(at);
  return age < 86_400_000 ? "fresh" : age < 30 * 86_400_000 ? "recent" : "stale";
}

export function listingEvidence(b: Discovered, now = Date.now()): EvidenceItem[] {
  const at = b.fetched_at;
  const f = freshness(at, now);
  const src = "Google Places (Google Maps)";
  const items: EvidenceItem[] = [
    { kind: "third_party_listing", statement: `Listed as ${b.primary_type?.replace(/_/g, " ") ?? (b.types[0]?.replace(/_/g, " ") || "a business")}${b.address ? ` at ${b.address}` : ""}, open for business`, source: src, observed_at: at, freshness: f, confidence: 0.8 },
  ];
  if (b.phone || b.website) items.push({ kind: "third_party_listing", statement: `Publishes ${[b.phone && "a phone number", b.website && `a website (${b.website})`].filter(Boolean).join(" and ")}`, source: src, observed_at: at, freshness: f, confidence: 0.8, caveat: "a published contact is not permission to contact" });
  if (b.rating !== undefined && b.review_count) items.push({ kind: "third_party_reputation", statement: `${b.rating}★ from ${b.review_count} Google reviews`, source: src, observed_at: at, freshness: f, confidence: Math.min(0.9, 0.3 + b.review_count / 200), caveat: "reviews say nothing about availability or capacity for your order" });
  if (b.summary) items.push({ kind: "third_party_listing", statement: b.summary, source: src, observed_at: at, freshness: f, confidence: 0.6 });
  if (b.price_level) items.push({ kind: "third_party_listing", statement: `Google price level: ${b.price_level.replace(/^PRICE_LEVEL_/, "").toLowerCase().replace(/_/g, " ")}`, source: src, observed_at: at, freshness: f, confidence: 0.4, caveat: "a coarse signal, not a price" });
  return items;
}

export function websiteItems(w: WebsiteEvidence | undefined, now = Date.now()): EvidenceItem[] {
  if (!w) return [];
  const f = freshness(w.fetched_at, now);
  if (w.status !== "ok") return [{ kind: "vendor_claim", statement: `Website not read (${w.status.replace(/_/g, " ")})`, source: w.url, observed_at: w.fetched_at, freshness: f, confidence: 0 }];
  return [
    ...(w.description ? [{ kind: "vendor_claim" as const, statement: `Says: "${w.description.slice(0, 200)}"`, source: w.url, observed_at: w.fetched_at, freshness: f, confidence: 0.5 }] : []),
    ...w.price_claims.map((p) => ({ kind: "vendor_claim" as const, statement: `${p.text} ("${p.excerpt.slice(0, 120)}")`, source: w.url, observed_at: w.fetched_at, freshness: f, confidence: 0.4, caveat: "an advertised starting price, not a quote: only a quote to Haggle is binding" })),
    ...(w.emails.length ? [{ kind: "vendor_claim" as const, statement: `Publishes email ${w.emails.join(", ")}`, source: w.url, observed_at: w.fetched_at, freshness: f, confidence: 0.6, caveat: "a published contact is not permission to contact" }] : []),
  ];
}

export function historyEvidence(p: Profile | null, now = Date.now()): EvidenceItem[] {
  if (!p) return [];
  const quotes = p.history.filter((h) => h.kind === "quote" && h.total_usd !== undefined && !h.job_id.startsWith("job_seed"));
  const items: EvidenceItem[] = quotes.slice(-5).map((h) => ({
    kind: "verified" as const, statement: `Quoted Haggle $${h.total_usd!.toLocaleString("en-US")}${h.quantity ? ` for ${h.quantity}` : ""} by ${h.channel}${h.round > 1 ? ` (round ${h.round}, after negotiation)` : ""}`,
    source: `Haggle deal ${h.job_id}`, observed_at: h.date, freshness: freshness(h.date, now), confidence: 0.9, caveat: "a past quote: an observation, not a price guarantee for a new order",
  }));
  if (p.per_unit_usd && quotes.length) items.push({ kind: "inferred_estimate", statement: `Typically ~$${p.per_unit_usd.typical} per unit (range $${p.per_unit_usd.low}–$${p.per_unit_usd.high}) across ${quotes.length} real quote${quotes.length === 1 ? "" : "s"}`, source: "Haggle's arithmetic over its own quotes", observed_at: quotes.at(-1)!.date, freshness: freshness(quotes.at(-1)!.date, now), confidence: Math.min(0.9, 0.3 + 0.15 * quotes.length) });
  return items;
}

export function contactEvidence(learning: ContactLearning | null, now = Date.now()): EvidenceItem[] {
  if (!learning) return [];
  const at = new Date(now).toISOString();
  const items: EvidenceItem[] = Object.entries(learning.channels).filter(([, r]) => r && r.contacted_jobs > 0).map(([ch, r]) => ({
    kind: "verified" as const, statement: `By ${ch === "imessage" ? "text" : ch}: replied in ${r!.replied_jobs} of ${r!.contacted_jobs} deal${r!.contacted_jobs === 1 ? "" : "s"}${r!.median_reply_minutes !== undefined ? `, median reply ${r!.median_reply_minutes} min` : ""}, ${r!.quotes} quote${r!.quotes === 1 ? "" : "s"}`,
    source: "Haggle's message history", observed_at: at, freshness: "fresh" as const, confidence: r!.confidence, ...(r!.contacted_jobs < 2 ? { caveat: "one deal: too little to call a habit" } : {}),
  }));
  if (learning.stated_preference) items.push({ kind: "verified", statement: `Asked to be reached by ${learning.stated_preference.channel === "imessage" ? "text" : learning.stated_preference.channel}: "${learning.stated_preference.excerpt.slice(0, 100)}"`, source: "the business's own reply", observed_at: learning.stated_preference.at, freshness: freshness(learning.stated_preference.at, now), confidence: 0.9 });
  return items;
}

/** What nobody has confirmed yet; stated so an agent never assumes it. */
export function unknowns(hasQuote: boolean): string[] {
  return [
    "availability on your date: only the business can confirm it",
    "capacity for your quantity: reviews and listings don't establish it",
    hasQuote ? "today's all-in price for a new order: past quotes are observations, not guarantees" : "the all-in price: no quote yet (advertised prices are not quotes)",
  ];
}
