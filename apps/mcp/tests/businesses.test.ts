// One business contract for demo vendors and discovered real businesses: categories, the selection
// registry, the four contact states (found is not authorized) and evidence kinds. No network.
import { describe, expect, it } from "vitest";
import type { Profile } from "@haggle/core";
import type { FoundBusiness, ListingProvider, WeeklyHours } from "@haggle/engine";
import { contactEvidence, contactStatus, DiscoveryRegistry, e164, freshness, historyEvidence, hoursOf, listingEvidence, publishedEmails, requestCategory, routeFor, storedListing, unknowns, websiteItems, type Discovered } from "../src/businesses.ts";
import { workspaceVendorList, type ChannelStatus } from "../src/vendors.ts";

const CH: ChannelStatus = { email: true, imessage: true, phone: true, a2a: false, connectCommand: "connect @haggle", connected: new Set(["+15105550141"]), callsViaSharedLine: true };
const found = (o: Partial<Discovered> & { name: string; place_id: string }): Discovered => ({
  business_ref: `place:${o.place_id}`, types: ["plumber"], relevance: 1, in_area: true, score: 0.9, rank_reasons: [], source: "Google Places", attribution: "Google Maps",
  fetched_at: "2026-10-18T00:00:00.000Z", merged_listings: 1, category: "plumber", area: "Oakland, CA", ...o,
});

describe("request categories: demo caterers are never offered for other work", () => {
  it.each([
    ["drop-off catering", "catering"], ["hackathon lunch", "catering"], ["pizza for 30", "catering"], ["500 flyers", "printing"],
    ["fix a leaking kitchen pipe", "plumbing"], ["office move", "moving"], ["deep clean the office", "cleaning"], ["replace two outlets", "electrical"], ["office repairs", "repairs"],
    // A food word elsewhere in the request never pulls in caterers (acceptance P2, 2026-10-18).
    ["post-event cleaning crew for our catered dinner", "cleaning"], ["repair of a commercial pizza oven", "repairs"], ["photographer for a dinner party", "photography"],
    ["catering for a cleaning company offsite", "catering"], ["DJ for the hackathon dinner", "entertainment"], ["tent rental for a lunch event", "rentals"],
  ])("%s → %s", (what, cat) => expect(requestCategory(what)).toBe(cat));
});

describe("discovered businesses are selectable for a while, by name or ref", () => {
  it("exact names, unique partial names, refs; ambiguity is reported; entries expire", () => {
    let t = 0;
    const reg = new DiscoveryRegistry(1000, () => t);
    reg.remember([found({ name: "Ace Plumbing & Drain", place_id: "A1" }), found({ name: "Bolt Plumbing", place_id: "B2" })]);
    expect(reg.find("ace plumbing and drain").map((b) => b.place_id)).toEqual(["A1"]);
    expect(reg.find("Bolt").map((b) => b.place_id)).toEqual(["B2"]);
    expect(reg.find("Plumbing")).toHaveLength(2); // ambiguous: the caller fails closed
    expect(reg.get("place:A1")?.name).toBe("Ace Plumbing & Drain");
    t = 2000;
    expect(reg.get("place:A1")).toBeNull();
    expect(reg.find("Bolt")).toEqual([]);
  });
});

describe("contact states: discovered → contact found → authorized → verified responsive", () => {
  const allow = (list: string[]) => (c: { email?: string; phone?: string }) => list.includes((c.email ?? c.phone)!);
  it("a published contact is never permission; authorization needs the allowlist and a channel that can send", () => {
    expect(e164("+1 510-555-0141")).toBe("+15105550141");
    expect(e164("(510) 555-0177")).toBe("+15105550177");
    expect(e164("call us")).toBeNull();
    const unauth = routeFor("phone", "+15105550177", "Google Places listing", allow([]), CH);
    expect(unauth).toMatchObject({ authorized: false, ready: false, contact: "+1•••77", blocker: expect.stringMatching(/finding a contact isn't permission/) });
    const notConnected = routeFor("phone", "+15105550177", "Google Places listing", allow(["+15105550177"]), CH);
    expect(notConnected).toMatchObject({ authorized: true, ready: false, blocker: expect.stringMatching(/shared iMessage line/) });
    const ok = routeFor("phone", "+15105550141", "Google Places listing", allow(["+15105550141"]), CH);
    expect(ok).toMatchObject({ authorized: true, ready: true });
    expect(contactStatus([], null).state).toBe("discovered");
    expect(contactStatus([unauth], null).state).toBe("contact_found");
    expect(contactStatus([unauth, ok], null).state).toBe("authorized");
    const replied = { channels: { phone: { contacted_jobs: 1, replied_jobs: 1, quotes: 1, response_rate: 1, confidence: 0.25 } } };
    expect(contactStatus([ok], replied)).toMatchObject({ state: "verified_responsive", responded_before: true });
    expect(contactStatus([unauth], replied).state).toBe("contact_found"); // replied once before, still not authorized now
  });
});

describe("evidence keeps its kind, source, time and limits", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  it("listing facts and reviews are third-party; website prices are claims, not quotes", () => {
    const b = found({ name: "Ace", place_id: "A1", rating: 4.7, review_count: 318, phone: "+1 510-555-0141", website: "https://ace.example/", primary_type: "plumber", price_level: "PRICE_LEVEL_MODERATE" });
    const items = listingEvidence(b, now);
    expect(items.map((i) => i.kind)).toEqual(["third_party_listing", "third_party_listing", "third_party_reputation", "third_party_listing"]);
    expect(items.find((i) => i.kind === "third_party_reputation")).toMatchObject({ statement: "4.7★ from 318 Google reviews", source: "Google Places (Google Maps)", caveat: expect.stringMatching(/availability or capacity/) });
    const web = websiteItems({ url: "https://ace.example/", fetched_at: "2026-09-01T00:00:00Z", status: "ok", emails: ["jobs@ace.example"], phones: [], price_claims: [{ text: "advertised from $149 per visit", amount_usd: 149, excerpt: "Leak repairs starting at $149 per visit" }] }, now);
    expect(web.every((i) => i.kind === "vendor_claim")).toBe(true);
    expect(web.find((i) => /\$149/.test(i.statement))).toMatchObject({ freshness: "stale", caveat: expect.stringMatching(/not a quote/) });
    expect(freshness("2026-10-18T06:00:00Z", now)).toBe("fresh");
  });

  it("Haggle's own quotes are verified observations (never seed samples); estimates are inferred; one deal isn't a habit", () => {
    const p = { history: [
      { date: "2026-10-11T00:00:00Z", job_id: "job_seed_05", channel: "phone", kind: "quote", total_usd: 675, per_unit_usd: 27, quantity: 25, round: 1 },
      { date: "2026-10-17T00:00:00Z", job_id: "job_real", channel: "phone", kind: "quote", total_usd: 7000, per_unit_usd: 35, quantity: 200, round: 1 },
    ], per_unit_usd: { low: 35, typical: 35, high: 35 } } as unknown as Profile;
    const h = historyEvidence(p, now);
    expect(h.map((i) => i.kind)).toEqual(["verified", "inferred_estimate"]);
    expect(h[0]).toMatchObject({ statement: "Quoted Haggle $7,000 for 200 by phone", caveat: expect.stringMatching(/not a price guarantee/) });
    expect(JSON.stringify(h)).not.toMatch(/675|job_seed/);
    const c = contactEvidence({ channels: { email: { contacted_jobs: 1, replied_jobs: 1, quotes: 1, response_rate: 1, confidence: 0.25 } } }, now);
    expect(c[0]).toMatchObject({ kind: "verified", caveat: "one deal: too little to call a habit" });
    expect(unknowns(false).join(" ")).toMatch(/availability.*capacity.*advertised prices are not quotes/);
  });
});

describe("published emails and opening hours of a found business", () => {
  const listed: WeeklyHours = { timezone: "America/Los_Angeles", intervals: [{ day: 1, startMinute: 480, endMinute: 1020 }], display: ["Mon 08:00–17:00"], source: "Amazon Location Service" };
  const site: WeeklyHours = { timezone: null, intervals: [{ day: 2, startMinute: 420, endMinute: 1140 }], display: ["Tue 07:00–19:00"], source: "business website" };
  const web = (hours?: WeeklyHours, emails: string[] = []) => ({ url: "https://b.example/", fetched_at: "2026-10-18T00:00:00.000Z", status: "ok" as const, emails, phones: [], price_claims: [], ...(hours ? { hours } : {}) });
  const aws = (o: Partial<Discovered> = {}) => found({ name: "Bolt", place_id: "AQAAAEJvbHQ", business_ref: "aws:AQAAAEJvbHQ", source: "Amazon Location Service", attribution: "Amazon Location Service (data © HERE)", ...o });

  it("listing emails first, then the website's; deduplicated, at most three", () => {
    expect(publishedEmails(aws({ listing_emails: ["dispatch@b.example"], website_evidence: web(undefined, ["office@b.example", "Dispatch@b.example", "a@b.example", "c@b.example"]) }))).toEqual(["dispatch@b.example", "office@b.example", "a@b.example"]);
  });

  it("listing hours win; website hours fall back, in the listing's timezone", () => {
    expect(hoursOf(aws({ hours: listed, website_evidence: web(site) }))).toBe(listed);
    expect(hoursOf(aws({ timezone: "America/Los_Angeles", website_evidence: web(site) }))).toEqual({ ...site, timezone: "America/Los_Angeles" });
    expect(hoursOf(aws())).toBeUndefined();
    expect(listingEvidence(aws({ hours: listed })).map((e) => e.statement)).toContain("Opening hours: Mon 08:00–17:00 (America/Los_Angeles)");
  });

  it("stored hours come from a Storage lookup, never from a browsing (SingleUse) result", async () => {
    const calls: unknown[] = [];
    const provider = (hours?: WeeklyHours): ListingProvider => ({
      kind: "amazon", source: "Amazon Location Service", attribution: "x", owns: (r) => r.startsWith("aws:"), discover: async () => [],
      details: async (ref, o) => { calls.push(o?.intendedUse); return { ...aws(), ...(hours ? { hours, timezone: "America/Los_Angeles" } : {}) } as FoundBusiness; },
    });
    expect(await storedListing(aws({ hours: listed }), { listing: provider(listed) })).toEqual({ opening_hours: listed, timezone: "America/Los_Angeles" });
    expect(calls).toEqual(["Storage"]);
    // The Storage lookup has no hours: the browsing result's hours are not stored; the website's are.
    expect(await storedListing(aws({ hours: listed, website_evidence: web(site) }), { listing: provider() })).toEqual({ opening_hours: site });
    expect(await storedListing(aws({ hours: listed }), {})).toEqual({});
  });

  it("a workspace vendor carries its stored hours (bad rows ignored)", () => {
    const [v] = workspaceVendorList([{ name: "Ace", contact: "+15105550141", channel: "phone", opening_hours: listed, timezone: "America/Los_Angeles" }, { name: "Ace", contact: "ace@a.example", opening_hours: { intervals: "x" } }]);
    expect(v).toMatchObject({ phone: "+15105550141", email: "ace@a.example", opening_hours: listed, timezone: "America/Los_Angeles" });
    expect(workspaceVendorList([{ name: "B", contact: "b@b.example", opening_hours: "Mon 9-5" }])[0]).not.toHaveProperty("opening_hours");
  });
});
