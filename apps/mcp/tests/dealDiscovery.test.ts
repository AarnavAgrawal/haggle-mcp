// deal finds the businesses itself (src/dealDiscovery.ts): which found businesses it may email once the
// human says yes. Only ones that publish an email; never a suppressed (opted-out or bounced) one, an
// existing vendor, the approver's own contact or a phone-only listing; at most the limit; and when there
// are none, a reason the user understands (no area, discovery off, listings down, nothing nearby).
// Fake listing provider, no network.
import { describe, expect, it } from "vitest";
import { PlacesError, type FoundBusiness, type ListingProvider } from "@haggle/engine";
import { DiscoveryRegistry } from "../src/businesses.ts";
import { confirmedBy, findForDeal, namedCandidate, previewEntry, uniqueContacts, withoutContact, type FindOptions, type FoundCandidate } from "../src/dealDiscovery.ts";
import type { Runtime } from "../src/runtime.ts";

const biz = (name: string, over: Partial<FoundBusiness> = {}): FoundBusiness => ({
  business_ref: `place:${name.replace(/\W+/g, "")}`, place_id: name.replace(/\W+/g, ""), name, types: ["plumber"], relevance: 1, in_area: true, score: 0.9, rank_reasons: [],
  source: "Google Places", attribution: "Google Maps", fetched_at: "2026-10-31T12:00:00.000Z", merged_listings: 1, ...over,
}) as FoundBusiness;

const LISTED = [
  biz("Ace Plumbing", { listing_emails: ["Jobs@Ace.example"] }),
  biz("Phone Only Rooter", { phone: "+15105550199" }),
  biz("Opted Out Drains", { listing_emails: ["stop@optout.example"] }),
  biz("Already Saved Pipes", { listing_emails: ["hello@saved.example"] }),
  biz("Approver Plumbing", { listing_emails: ["boss@approver.example"] }),
  biz("Bolt Plumbing", { listing_emails: ["office@bolt.example"], hours: { timezone: "America/Los_Angeles", source: "Amazon Location Service", display: ["Daily 08:00-18:00"], intervals: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: 480, endMinute: 1080 })) } }),
  biz("Ace Plumbing (duplicate)", { listing_emails: ["jobs@ace.example"] }),
  biz("Cora Plumbing", { listing_emails: ["hi@cora.example"] }),
];

function listing(result: FoundBusiness[] | PlacesError): ListingProvider {
  return {
    kind: "google", source: "Google Places", attribution: "Google Maps", owns: (r) => r.startsWith("place:"), details: async () => null,
    discover: async () => { if (result instanceof PlacesError) throw result; return result; },
  };
}

function opts(over: Partial<FindOptions> & { listing?: ListingProvider | null; email?: boolean; ch?: Record<string, unknown> } = {}): FindOptions {
  const { listing: l = listing(LISTED), email = true, ch = {}, ...rest } = over;
  const rt = { mode: "mock", ...(l ? { listing: l } : {}), channels: async () => ({ email, ...ch }) } as unknown as Runtime;
  return {
    rt, registry: new DiscoveryRegistry(), category: "plumbing", area: "Oakland, CA",
    existing: new Set(["hello@saved.example"]), reserved: new Set(["boss@approver.example"]),
    suppressed: async (cs) => new Set(cs.filter((c) => c === "stop@optout.example")),
    limit: 6, now: new Date("2026-10-31T19:00:00Z"), timezone: "America/Los_Angeles", ...rest,
  };
}

describe("findForDeal", () => {
  it("keeps only businesses with a published email; never suppressed, saved, reserved or phone-only ones", async () => {
    const r = await findForDeal(opts());
    expect(r.status).toBe("ok");
    expect(r.candidates.map((c) => [c.name, c.email, c.email_from])).toEqual([
      ["Ace Plumbing", "jobs@ace.example", "listing"],
      ["Bolt Plumbing", "office@bolt.example", "listing"],
      ["Cora Plumbing", "hi@cora.example", "listing"],
    ]);
    expect(r.skipped).toEqual({ no_email: 2, suppressed: 1, existing: 1 });
    expect(JSON.stringify(r.candidates)).not.toMatch(/optout|5105550199|approver|saved\.example/);
    expect(r.candidates[1]!.hours_today).toBe("Open today 8am–6pm");
  });

  it("caps the found businesses at the limit", async () => {
    expect((await findForDeal(opts({ limit: 2 }))).candidates.map((c) => c.name)).toEqual(["Ace Plumbing", "Bolt Plumbing"]);
  });

  it("says why it found nobody: off, no area, email off, listings down, nothing with an email", async () => {
    expect(await findForDeal(opts({ listing: null }))).toMatchObject({ status: "off", candidates: [], reason: expect.stringMatching(/finding businesses is off/) });
    expect(await findForDeal(opts({ area: null }))).toMatchObject({ status: "no_area", reason: expect.stringMatching(/no area/) });
    expect(await findForDeal(opts({ email: false }))).toMatchObject({ status: "channels_off", reason: expect.stringMatching(/email, calls and texts are all off/) });
    expect(await findForDeal(opts({ listing: listing(new PlacesError("unavailable", "down")) }))).toMatchObject({ status: "listings_down", reason: expect.stringMatching(/unavailable/) });
    expect(await findForDeal(opts({ listing: listing(new PlacesError("area_not_found", "?")) }))).toMatchObject({ status: "no_area", reason: expect.stringMatching(/don't know the area/) });
    expect(await findForDeal(opts({ listing: listing([biz("Phone Only", { phone: "+15105550100" })]) }))).toMatchObject({ status: "nothing_found", reason: expect.stringMatching(/none of the 1 plumbing businesses found near Oakland, CA can be reached/) });
    expect(await findForDeal(opts({ listing: listing([]) }))).toMatchObject({ status: "nothing_found", reason: "no plumbing businesses were found near Oakland, CA" });
  });

  it("previews a found business as will_authorize_on_start by email, with where it was found", async () => {
    const [ace] = (await findForDeal(opts())).candidates;
    expect(previewEntry(ace!)).toEqual({
      name: "Ace Plumbing", business_ref: "place:AcePlumbing", channel: "email", contact_state: "will_authorize_on_start", ready: true, found: true,
      found_via: { listing: "Google Places", ref: "place:AcePlumbing", email_from: "listing" },
    });
  });

  it("passes the user's preferences to the search", async () => {
    let got: unknown;
    const l = { ...listing(LISTED), discover: async (_c: string, _a: string, _n: number, prefs?: unknown) => { got = prefs; return LISTED; } };
    await findForDeal(opts({ listing: l, preferences: { cuisine: "thai", price: "budget" } }));
    expect(got).toEqual({ cuisine: "thai", price: "budget" });
  });

  it("asks for enough listings that restaurants without an email don't crowd out the rest", async () => {
    let asked = 0;
    await findForDeal(opts({ listing: { ...listing(LISTED), discover: async (_c, _a, n) => { asked = n; return LISTED; } } }));
    expect(asked).toBe(20);
  });

  describe("reaches a found business on whatever it publishes", () => {
    const CALLS = { phone: true, callsViaSharedLine: false };
    const DOMINOS = biz("Domino's", { phone: "(510) 555-0199" });

    it("calls a business that publishes only a phone number", async () => {
      const r = await findForDeal(opts({ ch: CALLS, listing: listing([DOMINOS]) }));
      expect(r.candidates.map((c) => [c.name, c.channel, c.phone])).toEqual([["Domino's", "phone", "+15105550199"]]);
    });

    it("texts it when calls are off and SMS is on", async () => {
      const r = await findForDeal(opts({ ch: { sms: true }, listing: listing([DOMINOS]) }));
      expect(r.candidates.map((c) => c.channel)).toEqual(["imessage"]);
    });

    it("emails first when a business publishes both", async () => {
      const r = await findForDeal(opts({ ch: CALLS, listing: listing([biz("Ace Plumbing", { listing_emails: ["jobs@ace.example"], phone: "+15105550100" })]) }));
      expect(r.candidates.map((c) => [c.channel, c.email])).toEqual([["email", "jobs@ace.example"]]);
    });

    it("still reaches people by phone when email is off", async () => {
      expect((await findForDeal(opts({ email: false, ch: CALLS, listing: listing([DOMINOS]) }))).candidates.map((c) => c.channel)).toEqual(["phone"]);
    });

    it("calls a chain location: its number is the store's, unlike its website's inbox", async () => {
      const chain = biz("Domino's", { chain: "Domino's", phone: "+15105550199", website: "https://dominos.example/" });
      const withSite = { ...chain, category: "catering", area: "Oakland, CA", website_evidence: { url: chain.website!, fetched_at: "2026-11-05T00:00:00Z", status: "ok" as const, emails: ["privacy@dominos.example"], phones: [], price_claims: [] } };
      const r = await findForDeal(opts({ ch: CALLS, listing: listing([withSite as FoundBusiness]) }));
      expect(r.candidates.map((c) => [c.channel, c.email])).toEqual([["phone", undefined]]);
    });

    it("never contacts a number that opted out", async () => {
      const r = await findForDeal(opts({ ch: CALLS, listing: listing([DOMINOS]), suppressed: async (cs) => new Set(cs.filter((c) => c === "+15105550199")) }));
      expect(r.candidates).toEqual([]);
      expect(r.skipped.suppressed).toBe(1);
    });

    it("never calls the approver's own number, or one already saved", async () => {
      expect((await findForDeal(opts({ ch: CALLS, listing: listing([DOMINOS]), reserved: new Set(["+15105550199"]) }))).candidates).toEqual([]);
      const saved = await findForDeal(opts({ ch: CALLS, listing: listing([DOMINOS]), existing: new Set(["+15105550199"]) }));
      expect(saved.candidates).toEqual([]);
      expect(saved.skipped.existing).toBe(1);
    });

    it("keeps the number out of the preview", async () => {
      const [c] = (await findForDeal(opts({ ch: CALLS, listing: listing([DOMINOS]) }))).candidates;
      expect(previewEntry(c!)).toMatchObject({ name: "Domino's", channel: "phone", contact_state: "will_authorize_on_start", ready: true });
      expect(JSON.stringify(previewEntry(c!))).not.toMatch(/5550199/);
    });

    it("can't cold-call over the shared iMessage line: the business is named as unreachable", async () => {
      const r = await findForDeal(opts({ ch: { phone: true, callsViaSharedLine: true, connected: new Set() }, listing: listing([DOMINOS]) }));
      expect(r.candidates).toEqual([]);
      expect(r.not_reachable).toEqual([{ name: "Domino's", business_ref: "place:Dominos", phone_published: true }]);
      expect(JSON.stringify(r.not_reachable)).not.toMatch(/5550199/);
    });

    it("names a business with no way to reach it even when it found nobody else", async () => {
      const r = await findForDeal(opts({ listing: listing([biz("Quiet Drains")]) }));
      expect(r.status).toBe("nothing_found");
      expect(r.not_reachable?.map((b) => b.name)).toEqual(["Quiet Drains"]);
    });
  });

  describe("a business the user named gets the same checks as one the search found", () => {
    const CALLS = { email: true, phone: true, callsViaSharedLine: false } as never;
    const found = (over: Partial<FoundBusiness>) => ({ ...biz("Domino's", over), category: "catering", area: "Oakland, CA" });
    const check = (over: Record<string, unknown> = {}) => ({ ch: CALLS, mode: "mock" as const, reserved: new Set<string>(), suppressed: async () => new Set<string>(), ...over });

    it("reaches it on what it publishes", async () => {
      expect(await namedCandidate(found({ phone: "+15105550199" }), check())).toMatchObject({ candidate: { channel: "phone", phone: "+15105550199" } });
    });

    it("refuses it when any contact it publishes opted out, even if another would work", async () => {
      const r = await namedCandidate(found({ listing_emails: ["hi@dominos.example"], phone: "+15105550199" }), check({ suppressed: async () => new Set(["+15105550199"]) }));
      expect(r).toMatchObject({ refused: expect.stringMatching(/asked not to be contacted/) });
      expect(JSON.stringify(r)).not.toMatch(/5550199/);
    });

    it("refuses it when its only contact is the approver's own", async () => {
      expect(await namedCandidate(found({ phone: "+15105550199" }), check({ reserved: new Set(["+15105550199"]) }))).toMatchObject({ refused: expect.stringMatching(/reserved/) });
    });

    it("has nothing to say about a business with no contact at all", async () => {
      expect(await namedCandidate(found({}), check())).toBeNull();
    });

    it("shows today's hours in the preview, as the search does", async () => {
      const hours = { timezone: "America/Los_Angeles", source: "Amazon Location Service", display: ["Daily 08:00-18:00"], intervals: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: 480, endMinute: 1080 })) };
      const r = await namedCandidate(found({ phone: "+15105550199", hours } as never), check({ now: new Date("2026-10-31T19:00:00Z"), timezone: "America/Los_Angeles" }));
      expect(r).toMatchObject({ candidate: { hours_today: "Open today 8am–6pm" } });
    });
  });

  it("keeps a published number out of a message the user sees", () => {
    expect(withoutContact("+15105550199 asked not to be contacted by Haggle.", "+15105550199")).toBe("its contact asked not to be contacted by Haggle.");
  });

  it("contacts one number once, however many listings carry it", () => {
    const c = (name: string, phone: string) => ({ name, business_ref: `place:${name}`, channel: "phone", phone }) as FoundCandidate;
    expect(uniqueContacts([c("A", "+15105550199"), c("B", "+15105550199"), c("C", "+15105550100")], []).map((x) => x.name)).toEqual(["A", "C"]);
    expect(uniqueContacts([c("A", "+15105550199")], [{ phone: "+15105550199" }])).toEqual([]);
  });

  it("searches the whole request for work Haggle has no category for", async () => {
    let searched = "";
    await findForDeal(opts({ category: "walking", searchFor: "dog walking for two dogs", listing: { ...listing(LISTED), discover: async (c) => { searched = c; return LISTED; } } }));
    expect(searched).toBe("dog walking for two dogs");
  });

  it("does email a chain store that publishes its own address on the listing", async () => {
    const r = await findForDeal(opts({ listing: listing([biz("Pizza Hut Oakland", { chain: "Pizza Hut", listing_emails: ["store4471@pizzahut.example"] })]) }));
    expect(r.candidates.map((c) => c.email)).toEqual(["store4471@pizzahut.example"]);
  });

  describe("the user's yes survives a search that came back different", () => {
    const previewed = async () => { const registry = new DiscoveryRegistry(); await findForDeal(opts({ registry })); return registry; };

    it("keeps a confirmed business this run's search no longer returns", async () => {
      const r = await findForDeal(opts({ registry: await previewed(), listing: listing([]), confirming: ["place:BoltPlumbing"] }));
      expect(r.candidates.map((c) => c.name)).toEqual(["Bolt Plumbing"]);
    });

    it("puts confirmed businesses first, so the limit can't push them out", async () => {
      const r = await findForDeal(opts({ registry: await previewed(), limit: 1, confirming: ["place:CoraPlumbing"] }));
      expect(r.candidates.map((c) => c.name)).toEqual(["Cora Plumbing"]);
    });

    it("still refuses a confirmed business that has since opted out", async () => {
      const r = await findForDeal(opts({ registry: await previewed(), listing: listing([]), confirming: ["place:OptedOutDrains"] }));
      expect(r.candidates).toEqual([]);
    });

    it("never reaches a business found for a different kind of work", async () => {
      const r = await findForDeal(opts({ registry: await previewed(), listing: listing([]), category: "catering", confirming: ["place:BoltPlumbing"] }));
      expect(r.candidates).toEqual([]);
    });

    it("can't confirm an invented ref", async () => {
      const r = await findForDeal(opts({ registry: await previewed(), listing: listing([]), confirming: ["place:NoSuchBusiness"] }));
      expect(r.candidates).toEqual([]);
    });
  });

  it("records who confirmed: the web user, else the MCP client on the user's yes", () => {
    expect(confirmedBy("ana@example.com (u1)", "haggle-web")).toBe("web:ana@example.com (u1)");
    expect(confirmedBy(null, "claude-ai")).toBe("agent:claude-ai on the user's yes");
    expect(confirmedBy(null, undefined)).toBe("agent:mcp-client on the user's yes");
  });
});
