// Haggle finds the businesses itself (docs/state-and-next-fixes.md §3). When a deal names no businesses
// and the workspace has fewer than MIN_OWN_VENDORS vendors for the request's kind of work, deal searches
// public listings (the discover tool's path) for businesses that publish a business email. Found is not
// authorized: they appear in the preview as "will authorize on start", and only the human's yes
// (deal with confirm_discovered) saves each one as a vendor with consent public_listing_email (email
// only, never a call or a text) and then emails it.
//
// Every step fails closed: no area, discovery off, email off or listings down means no candidates and a
// reason the deal can show; suppressed contacts, existing vendors, the approver's own contacts and (live)
// simulated contacts never appear.
import { DEFAULT_CONTACT_TIMEZONE, PlacesError, simulatedContact, type ListingProvider } from "@haggle/engine";
import { hoursLine, publishedEmails, withWebsite, type Discovered, type DiscoveryRegistry } from "./businesses.ts";
import type { Runtime } from "./runtime.ts";

/** How many listings deal asks for (more than it keeps: many publish no email). */
export const DISCOVER_COUNT = 12;
/** At most this many found businesses on one deal. */
export const MAX_DISCOVERED_PER_DEAL = 6;
/** With fewer workspace vendors than this for the request's kind of work, deal also finds businesses. */
export const MIN_OWN_VENDORS = 3;
/** How long a search waits for the found businesses' websites (their published emails), all in parallel. */
export const WEBSITE_BUDGET_MS = 6_000;

/** A found business deal may email once the human confirms it. */
export interface FoundCandidate {
  name: string;
  business_ref: string;
  email: string;
  /** Where the email was published: the listing itself or the business's own website. */
  email_from: "listing" | "website";
  source: Discovered["source"];
  hours_today?: string;
  found: Discovered;
}

export type DiscoveryStatus = "ok" | "off" | "no_area" | "email_off" | "nothing_found" | "listings_down";
export interface DiscoveryOutcome {
  status: DiscoveryStatus;
  candidates: FoundCandidate[];
  /** Why there are none, in words the user understands (status other than ok). */
  reason?: string;
  /** How many results were left out, and why. */
  skipped: { no_email: number; suppressed: number; existing: number };
}

/**
 * Public-listing search plus each business's website, within a time budget (a slow site just has no
 * emails), remembered in this workspace's registry so names and refs resolve later. Throws PlacesError.
 */
export async function searchListings(rt: Runtime & { listing: ListingProvider }, registry: DiscoveryRegistry, category: string, area: string, count: number, budgetMs = WEBSITE_BUDGET_MS): Promise<Discovered[]> {
  const found = (await rt.listing.discover(category, area, count)).map((b) => ({ ...b, category, area }));
  registry.remember(found);
  const budget = (b: Discovered) => new Promise<Discovered>((done) => { const t = setTimeout(() => done(b), budgetMs); t.unref?.(); });
  return Promise.all(found.map((b) => Promise.race([withWebsite(b, rt, registry), budget(b)])));
}

export interface FindOptions {
  rt: Runtime;
  registry: DiscoveryRegistry;
  /** The request's kind of work ("plumbing"): the search and the category each saved vendor gets. */
  category: string;
  area: string | null;
  /** Contacts the workspace already has as vendors (lowercased emails / phones). */
  existing: Set<string>;
  /** Contacts reserved for approvals (the approver's own). */
  reserved: Set<string>;
  /** Which of these contacts are suppressed (opted out or bounced). */
  suppressed: (contacts: string[]) => Promise<Set<string>>;
  limit: number;
  now?: Date;
  timezone?: string;
}

const none = (status: Exclude<DiscoveryStatus, "ok">, reason: string, skipped = { no_email: 0, suppressed: 0, existing: 0 }): DiscoveryOutcome => ({ status, candidates: [], reason, skipped });

/** The businesses deal would email for this request, best first, or why there are none. Never contacts anyone. */
export async function findForDeal(o: FindOptions): Promise<DiscoveryOutcome> {
  if (!o.rt.listing) return none("off", "finding businesses is off on this server (no public-listing key is configured)");
  if (!o.area) return none("no_area", "no area was given and the workspace has no default area");
  if (!(await o.rt.channels()).email) return none("email_off", "email outreach is off on this server, and found businesses are only ever emailed");
  if (o.limit <= 0) return none("nothing_found", "this deal already has as many businesses as it may contact");
  let found: Discovered[];
  try {
    found = await searchListings(o.rt as Runtime & { listing: ListingProvider }, o.registry, o.category, o.area, DISCOVER_COUNT);
  } catch (e) {
    if (!(e instanceof PlacesError)) throw e;
    return none(e.code === "area_not_found" ? "no_area" : "listings_down", e.code === "area_not_found" ? `the listings don't know the area "${o.area}"` : `the business listings are unavailable right now (${e.code.replace(/_/g, " ")})`);
  }
  const skipped = { no_email: 0, suppressed: 0, existing: 0 };
  const withEmail = found.map((b) => ({ b, emails: publishedEmails(b).filter((e) => !o.reserved.has(e) && !(o.rt.mode === "live" && simulatedContact(e))) }));
  const all = withEmail.flatMap((x) => x.emails);
  const sup = all.length ? await o.suppressed(all) : new Set<string>();
  const out: FoundCandidate[] = [];
  const seen = new Set<string>();
  for (const { b, emails } of withEmail) {
    if (!emails.length) { skipped.no_email++; continue; }
    // A business with any suppressed published address opted out (or bounced): it is left out entirely.
    if (emails.some((e) => sup.has(e))) { skipped.suppressed++; continue; }
    if (emails.some((e) => o.existing.has(e)) || (b.phone && o.existing.has(b.phone))) { skipped.existing++; continue; }
    const email = emails[0]!;
    if (seen.has(email)) continue; // the same business listed twice
    seen.add(email);
    const fromListing = (b.listing_emails ?? []).some((e) => e.toLowerCase() === email);
    const today = hoursLine(b, o.timezone ?? DEFAULT_CONTACT_TIMEZONE, o.now);
    out.push({ name: b.name, business_ref: b.business_ref, email, email_from: fromListing ? "listing" : "website", source: b.source, ...(today ? { hours_today: today } : {}), found: b });
    if (out.length >= o.limit) break;
  }
  if (!out.length) {
    const why = found.length
      ? `none of the ${found.length} ${o.category} businesses found near ${o.area} publish an email Haggle may use${skipped.suppressed ? ` (${skipped.suppressed} opted out or bounced)` : ""}${skipped.existing ? ` (${skipped.existing} already saved)` : ""}`
      : `no ${o.category} businesses were found near ${o.area}`;
    return none("nothing_found", why, skipped);
  }
  return { status: "ok", candidates: out, skipped };
}

/** The preview entry for a found business (deal dry run and the unconfirmed real deal). */
export function previewEntry(c: FoundCandidate) {
  return {
    name: c.name, business_ref: c.business_ref, channel: "email" as const, contact_state: "will_authorize_on_start", ready: true, found: true,
    found_via: { listing: c.source, ref: c.business_ref, email_from: c.email_from },
    ...(c.hours_today ? { hours_today: c.hours_today } : {}),
  };
}

/** Who confirmed found businesses: the signed-in web user, else the MCP client acting on the user's yes. */
export function confirmedBy(actor: string | null, clientName: string | undefined): string {
  if (actor) return `web:${actor}`.slice(0, 120);
  const client = (clientName ?? "").replace(/[^\w .:-]+/g, "").trim().slice(0, 60) || "mcp-client";
  return `agent:${client} on the user's yes`;
}
