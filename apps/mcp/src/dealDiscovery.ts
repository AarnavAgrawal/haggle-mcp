// Haggle finds the businesses itself (docs/state-and-next-fixes.md §3). When a deal names no businesses
// and the workspace has fewer than MIN_OWN_VENDORS vendors for the request's kind of work, deal searches
// public listings (the discover tool's path). Each is reached on what it publishes: email first, else a
// call, else a text. They appear in the preview as "will authorize on start", and the human's yes (deal
// with confirm_discovered, or naming the business) saves each one as a vendor and contacts it.
//
// Every step fails closed: no area, discovery off, every channel off or listings down means no candidates
// and a reason the deal can show; suppressed contacts, existing vendors, the approver's own contacts and
// (live) simulated contacts never appear.
import { DEFAULT_CONTACT_TIMEZONE, PlacesError, simulatedContact, type ListingProvider, type SearchPreferences } from "@haggle/engine";
import { e164, hoursLine, publishedEmails, withWebsite, type Discovered, type DiscoveryRegistry } from "./businesses.ts";
import { DEMO_WORKSPACE_REASON } from "./demoWorkspace.ts";
import type { Runtime } from "./runtime.ts";
import type { ChannelStatus } from "./vendors.ts";

/** How many listings deal asks for (more than it keeps: some can't be reached at all). */
export const DISCOVER_COUNT = 20;
/** How many businesses a deal names as found but not reachable. */
const MAX_NOT_REACHABLE = 6;
/** At most this many found businesses on one deal. */
export const MAX_DISCOVERED_PER_DEAL = 6;
/** With fewer workspace vendors than this for the request's kind of work, deal also finds businesses. */
export const MIN_OWN_VENDORS = 3;
/** How long a search waits for the found businesses' websites (their published emails), all in parallel. */
export const WEBSITE_BUDGET_MS = 6_000;

/** How Haggle reaches a found business. */
export interface Reach {
  channel: "email" | "phone" | "imessage";
  email?: string;
  /** Where the email was published: the listing itself or the business's own website. */
  email_from?: "listing" | "website";
  phone?: string;
}

/** A found business deal contacts once the human confirms it. */
export interface FoundCandidate extends Reach {
  name: string;
  business_ref: string;
  source: Discovered["source"];
  hours_today?: string;
  found: Discovered;
}

export type DiscoveryStatus = "ok" | "off" | "no_area" | "channels_off" | "nothing_found" | "listings_down";
export interface DiscoveryOutcome {
  status: DiscoveryStatus;
  candidates: FoundCandidate[];
  /** Why there are none, in words the user understands (status other than ok). */
  reason?: string;
  /** How many results were left out, and why. */
  skipped: { no_email: number; suppressed: number; existing: number };
  /** Found, but with no channel that can reach it: named so they aren't dropped silently. */
  not_reachable?: NotReachable[];
}

/** A found business Haggle can't reach. Its published phone stays server-side. */
export interface NotReachable { name: string; business_ref: string; phone_published: boolean }

/**
 * Public-listing search plus each business's website, within a time budget (a slow site just has no
 * emails), remembered in this workspace's registry so names and refs resolve later. Throws PlacesError.
 */
export async function searchListings(rt: Runtime & { listing: ListingProvider }, registry: DiscoveryRegistry, category: string, area: string, count: number, budgetMs = WEBSITE_BUDGET_MS, prefs?: SearchPreferences, searchFor?: string): Promise<Discovered[]> {
  const found = (await rt.listing.discover(searchFor ?? category, area, count, prefs)).map((b) => ({ ...b, category, area }));
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
  /** A demo workspace (HAGGLE_DEMO_WORKSPACES): never finds businesses. */
  demoWorkspace?: boolean;
  /** What the user would like (cuisine, price): steers the search, never narrows it. */
  preferences?: SearchPreferences;
  /** The refs the user said yes to (confirm_discovered). */
  confirming?: string[];
  /** The words to search with, when they say more than the category (work with no category of its own: "dog walking", not "walking"). */
  searchFor?: string;
}

const none = (status: Exclude<DiscoveryStatus, "ok">, reason: string, skipped = { no_email: 0, suppressed: 0, existing: 0 }, notReachable: NotReachable[] = []): DiscoveryOutcome => ({ status, candidates: [], reason, skipped, ...(notReachable.length ? { not_reachable: notReachable } : {}) });

/** The addresses that reach this business. A chain's website speaks for the chain: its inbox isn't the local store's, so a chain counts only with an address on its own listing. */
const reachableEmails = (b: Discovered) => (b.chain ? (b.listing_emails ?? []).map((e) => e.toLowerCase()) : publishedEmails(b));

/**
 * The channel that reaches a number Haggle has never spoken to, or null. Calls over the shared iMessage
 * line and iMessage itself only reach a number that connected first, so a first contact needs the
 * buyer's own line, or SMS.
 */
function phoneChannel(phone: string, ch: ChannelStatus): "phone" | "imessage" | null {
  const connected = !!ch.connected?.has(phone);
  if (ch.phone && (!ch.callsViaSharedLine || connected)) return "phone";
  if (ch.imessage ? connected : ch.sms) return "imessage";
  return null;
}

/** How to reach a found business: its email if it publishes one, else a call, else a text; null when no channel can. */
export function reachFor(b: Discovered, ch: ChannelStatus, emails = reachableEmails(b), phone = e164(b.phone)): Reach | null {
  const email = ch.email ? emails[0] : undefined;
  if (email) return { channel: "email", email, email_from: (b.listing_emails ?? []).some((e) => e.toLowerCase() === email) ? "listing" : "website" };
  const by = phone ? phoneChannel(phone, ch) : null;
  return by ? { channel: by, phone: phone! } : null;
}

/** A message for the user, with the contact it mentions taken out: a published number stays server-side. */
export const withoutContact = (message: string, contact: string) => message.split(contact).join("its contact");

/** Each contact once, and none already on the deal: two listings can carry one number, and the engine refuses a duplicate after they are saved. */
export function uniqueContacts(found: FoundCandidate[], taken: { email?: string | null | undefined; phone?: string | null | undefined }[]): FoundCandidate[] {
  const seen = new Set(taken.flatMap((b) => [b.email?.toLowerCase(), b.phone]).filter(Boolean));
  return found.filter((c) => { const k = c.email ?? c.phone!; if (seen.has(k)) return false; seen.add(k); return true; });
}

/** A found business as a candidate for this deal. */
export const candidateFor = (b: Discovered, reach: Reach, today?: string): FoundCandidate => ({ name: b.name, business_ref: b.business_ref, ...reach, source: b.source, ...(today ? { hours_today: today } : {}), found: b });

/** The businesses deal would email for this request, best first, or why there are none. Never contacts anyone. */
export async function findForDeal(o: FindOptions): Promise<DiscoveryOutcome> {
  if (o.demoWorkspace) return none("off", DEMO_WORKSPACE_REASON);
  if (!o.rt.listing) return none("off", "finding businesses is off on this server (no public-listing key is configured)");
  if (!o.area) return none("no_area", "no area was given and the workspace has no default area");
  const ch = await o.rt.channels();
  if (!ch.email && !ch.phone && !ch.sms && !ch.imessage) return none("channels_off", "email, calls and texts are all off on this server");
  if (o.limit <= 0) return none("nothing_found", "this deal already has as many businesses as it may contact");
  let found: Discovered[];
  try {
    found = await searchListings(o.rt as Runtime & { listing: ListingProvider }, o.registry, o.category, o.area, DISCOVER_COUNT, WEBSITE_BUDGET_MS, o.preferences, o.searchFor);
  } catch (e) {
    if (!(e instanceof PlacesError)) throw e;
    return none(e.code === "area_not_found" ? "no_area" : "listings_down", e.code === "area_not_found" ? `the listings don't know the area "${o.area}"` : `the business listings are unavailable right now (${e.code.replace(/_/g, " ")})`);
  }
  // The user's yes names what the preview listed, but this run may differ: the wider searches are best
  // effort, and the preferences may not be repeated. So confirmed businesses stay in reach and come first
  // (the limit can't push them out); every check below still applies to them.
  const yes = new Set(o.confirming ?? []);
  if (yes.size) {
    const remembered = [...yes].filter((r) => !found.some((b) => b.business_ref === r)).flatMap((r) => { const b = o.registry.get(r); return b && b.category === o.category ? [b] : []; });
    found = [...found.filter((b) => yes.has(b.business_ref)), ...remembered, ...found.filter((b) => !yes.has(b.business_ref))];
  }
  const skipped = { no_email: 0, suppressed: 0, existing: 0 };
  const usable = (c: string) => !o.reserved.has(c) && !(o.rt.mode === "live" && simulatedContact(c));
  const listed = found.map((b) => {
    const phone = e164(b.phone);
    return { b, emails: reachableEmails(b).filter(usable), phone: phone && usable(phone) ? phone : null };
  });
  const all = listed.flatMap((x) => [...x.emails, ...(x.phone ? [x.phone] : [])]);
  const sup = all.length ? await o.suppressed(all) : new Set<string>();
  const out: FoundCandidate[] = [];
  const seen = new Set<string>();
  const notReachable: NotReachable[] = [];
  for (const { b, emails, phone } of listed) {
    const contacts = [...emails, ...(phone ? [phone] : [])];
    // A business with any suppressed published contact opted out (or bounced): it is left out entirely.
    if (contacts.some((c) => sup.has(c))) { skipped.suppressed++; continue; }
    if (contacts.some((c) => o.existing.has(c))) { skipped.existing++; continue; }
    const reach = reachFor(b, ch, emails, phone);
    if (!reach) {
      skipped.no_email++;
      // A contact held back above (the approver's own, a simulated one) isn't a business to name.
      const held = reachableEmails(b).length + (e164(b.phone) ? 1 : 0) > contacts.length;
      if (!held && notReachable.length < MAX_NOT_REACHABLE) notReachable.push({ name: b.name, business_ref: b.business_ref, phone_published: !!b.phone });
      continue;
    }
    const contact = reach.email ?? reach.phone!;
    if (seen.has(contact)) continue; // the same business listed twice
    seen.add(contact);
    if (out.length < o.limit) out.push(candidateFor(b, reach, hoursLine(b, o.timezone ?? DEFAULT_CONTACT_TIMEZONE, o.now)));
  }
  if (!out.length) {
    const why = found.length
      ? `none of the ${found.length} ${o.category} businesses found near ${o.area} can be reached${skipped.suppressed ? ` (${skipped.suppressed} opted out or bounced)` : ""}${skipped.existing ? ` (${skipped.existing} already saved)` : ""}`
      : `no ${o.category} businesses were found near ${o.area}`;
    return none("nothing_found", why, skipped, notReachable);
  }
  return { status: "ok", candidates: out, skipped, ...(notReachable.length ? { not_reachable: notReachable } : {}) };
}

/** The preview entry for a found business (deal dry run and the unconfirmed real deal). */
export function previewEntry(c: FoundCandidate) {
  return {
    name: c.name, business_ref: c.business_ref, channel: c.channel, contact_state: "will_authorize_on_start", ready: true, found: true,
    found_via: { listing: c.source, ref: c.business_ref, ...(c.email_from ? { email_from: c.email_from } : {}) },
    ...(c.hours_today ? { hours_today: c.hours_today } : {}),
  };
}

/**
 * A found business the user named: the same checks as one the search found, so a preview never promises
 * a business that won't be contacted. Refused when any contact it publishes opted out or bounced, or when
 * the only one left is held back; null when it publishes nothing Haggle can use.
 */
export async function namedCandidate(b: Discovered, o: Pick<FindOptions, "reserved" | "suppressed" | "now" | "timezone"> & { ch: ChannelStatus; mode: Runtime["mode"] }): Promise<{ candidate: FoundCandidate } | { refused: string } | null> {
  const usable = (c: string) => !o.reserved.has(c) && !(o.mode === "live" && simulatedContact(c));
  const published = [...reachableEmails(b), ...(e164(b.phone) ? [e164(b.phone)!] : [])];
  if (published.length && (await o.suppressed(published)).size) return { refused: "it asked not to be contacted, or Haggle's messages to it bounced." };
  const phone = e164(b.phone);
  const reach = reachFor(b, o.ch, reachableEmails(b).filter(usable), phone && usable(phone) ? phone : null);
  if (reach) return { candidate: candidateFor(b, reach, hoursLine(b, o.timezone ?? DEFAULT_CONTACT_TIMEZONE, o.now)) };
  return published.some((c) => !usable(c)) ? { refused: "its published contact is reserved for approvals." } : null;
}

/** Who confirmed found businesses: the signed-in web user, else the MCP client acting on the user's yes. */
export function confirmedBy(actor: string | null, clientName: string | undefined): string {
  if (actor) return `web:${actor}`.slice(0, 120);
  const client = (clientName ?? "").replace(/[^\w .:-]+/g, "").trim().slice(0, 60) || "mcp-client";
  return `agent:${client} on the user's yes`;
}
