// Demo vendor roster: who Haggle may contact and the exact blocker for everyone else. Pure; no network.
import { describe, expect, it } from "vitest";
import { blockerLines, buildRoster, DEMO_VENDORS, parseVendorConfig, rosterRecipients, type ChannelStatus } from "../src/vendors.ts";

const ON: ChannelStatus = { email: true, imessage: true, phone: true, a2a: true, connectCommand: "connect @haggle", connected: new Set(["+14155550111", "+14155550122"]), callsViaSharedLine: true };
const CONFIG = JSON.stringify({
  harbor_table: { email: "Harbor@InkboxMail.com" },
  sunset_kitchen: { phone: "+1 (415) 555-0111", channel: "imessage" },
  mission_eats: { phone: "+14155550122" },
  bay_catering: { a2a_card_url: "https://inkbox.ai/a2a/bay/card" },
  golden_grill: { email: "golden@inkboxmail.com" },
  quickquote_deli: { email: "deli@inkboxmail.com" },
});

describe("demo vendor roster", () => {
  it("six predefined vendors, every one simulated and labelled with who plays it", () => {
    expect(DEMO_VENDORS.map((v) => v.channel).sort()).toEqual(["a2a", "email", "email", "email", "imessage", "phone"]);
    const r = buildRoster({}, ON);
    expect(r).toHaveLength(6);
    expect(r.every((v) => v.simulated && v.played_by && !v.ready && v.blocker && v.fix)).toBe(true);
  });

  it("fully configured and connected → all six ready; contacts normalized and authorized", () => {
    const { contacts, errors } = parseVendorConfig(CONFIG);
    expect(errors).toEqual([]);
    const r = buildRoster(contacts, ON);
    expect(r.filter((v) => v.ready).map((v) => v.name)).toHaveLength(6);
    expect(r.find((v) => v.key === "sunset_kitchen")).toMatchObject({ channel: "imessage", phone: "+14155550111" });
    expect(rosterRecipients(contacts)).toEqual(expect.arrayContaining(["harbor@inkboxmail.com", "+14155550111", "+14155550122", "https://inkbox.ai/a2a/bay/card"]));
  });

  it("each missing piece gives a precise blocker and fix, never a guess", () => {
    const { contacts } = parseVendorConfig(CONFIG);
    const off = buildRoster(contacts, { ...ON, imessage: false, phone: false, a2a: false });
    expect(off.find((v) => v.key === "sunset_kitchen")).toMatchObject({ ready: false, blocker: "texting businesses is off on this server", fix: expect.stringContaining("HAGGLE_ENABLE_IMESSAGE=true") });
    // SMS on (iMessage off): the texted vendor is ready by SMS from the buyer's number, no connect step.
    expect(buildRoster(contacts, { ...ON, imessage: false, sms: true, connected: new Set() }).find((v) => v.key === "sunset_kitchen")).toMatchObject({ ready: true, channel: "imessage" });
    expect(off.find((v) => v.key === "mission_eats")).toMatchObject({ ready: false, fix: expect.stringContaining("HAGGLE_ENABLE_CALLS=true") });
    expect(off.find((v) => v.key === "bay_catering")).toMatchObject({ ready: false, fix: expect.stringContaining("HAGGLE_ENABLE_A2A=true") });
    expect(off.find((v) => v.key === "harbor_table")!.ready).toBe(true);

    const notConnected = buildRoster(contacts, { ...ON, connected: new Set() });
    expect(notConnected.find((v) => v.key === "sunset_kitchen")).toMatchObject({ ready: false, fix: 'Vendor: text "connect @haggle" to the Inkbox iMessage line from that iPhone.' });
    expect(notConnected.find((v) => v.key === "mission_eats")).toMatchObject({ ready: false, blocker: expect.stringContaining("shared iMessage line") });
    // A dedicated buyer number doesn't need the callee to connect.
    expect(buildRoster(contacts, { ...ON, connected: new Set(), callsViaSharedLine: false }).find((v) => v.key === "mission_eats")!.ready).toBe(true);
    // Couldn't check (Inkbox error) is not "ready".
    expect(buildRoster(contacts, { ...ON, connected: null }).find((v) => v.key === "sunset_kitchen")!.ready).toBe(false);
    expect(blockerLines(off)).toHaveLength(3);
  });

  it("a texted vendor (live-demo's TEXT_VENDOR) is a roster entry on the text channel: sms / text / imessage", () => {
    const { contacts, errors } = parseVendorConfig(JSON.stringify({ golden_grill: { phone: "+1 (415) 555-0133", channel: "sms" }, harbor_table: { email: "harbor@inkboxmail.com" } }));
    expect(errors).toEqual([]);
    expect(contacts.golden_grill).toMatchObject({ phone: "+14155550133", channel: "imessage" });
    const smsOnly = { ...ON, imessage: false, sms: true };
    expect(buildRoster(contacts, smsOnly).find((v) => v.key === "golden_grill")).toMatchObject({ ready: true, channel: "imessage", played_by: expect.stringContaining("SMS") });
    expect(buildRoster(contacts, { ...smsOnly, sms: false }).find((v) => v.key === "golden_grill")).toMatchObject({ ready: false, fix: expect.stringContaining("HAGGLE_ENABLE_SMS=true") });
    expect(parseVendorConfig(JSON.stringify({ golden_grill: { phone: "+14155550133", channel: "fax" } })).errors).toEqual([expect.stringContaining("golden_grill: channel")]);
  });

  it("bad config is reported, not guessed", () => {
    expect(parseVendorConfig("{nope").errors).toEqual(["HAGGLE_DEMO_VENDORS is not valid JSON"]);
    const r = parseVendorConfig(JSON.stringify({ mission_eats: { phone: "415-555" }, harbor_table: { email: "not-an-email" } }));
    expect(r.errors).toEqual(["mission_eats: phone must be E.164", "harbor_table: bad email"]);
    expect(rosterRecipients(r.contacts)).toEqual([]);
  });

  it("one phone playing two vendors (call + text) is contacted once per deal", () => {
    const { contacts } = parseVendorConfig(JSON.stringify({ mission_eats: { phone: "+14155550122" }, sunset_kitchen: { phone: "+14155550122", channel: "imessage" } }));
    const r = buildRoster(contacts, ON);
    expect(r.find((v) => v.key === "sunset_kitchen")!.ready).toBe(true);
    expect(r.find((v) => v.key === "mission_eats")).toMatchObject({ ready: false, blocker: "same contact as Sunset Kitchen (one contact plays one vendor per deal)" });
  });
});

describe("naming vendors: deal(businesses=['Mission Eats']) without contact details", async () => {
  const { findVendors, resolveVendors, rosterBusinessId, businessRef } = await import("../src/vendors.ts");
  const { contacts } = parseVendorConfig(CONFIG);
  const roster = buildRoster(contacts, ON);
  const names = (r: ReturnType<typeof resolveVendors>) => (r.ok ? r.vendors.map((v) => v.name) : r.code);

  it("one named vendor resolves to exactly that vendor, with its configured contact and channel", () => {
    const r = resolveVendors(["Mission Eats"], roster);
    expect(names(r)).toEqual(["Mission Eats"]);
    expect(r.ok && r.vendors[0]).toMatchObject({ channel: "phone", phone: "+14155550122" });
  });

  it("every stable reference to the same vendor works: name, business_ref, slug, casing, '(demo)', engine id, legacy id", () => {
    const me = roster.find((v) => v.key === "mission_eats")!;
    for (const ref of ["mission eats", "MISSION EATS", "mission_eats", "mission-eats", "biz_mission_eats", "Mission Eats (demo)", "Mission", rosterBusinessId(me)!, rosterBusinessId(me, { legacy: true })!]) {
      expect(names(resolveVendors([ref], roster)), ref).toEqual(["Mission Eats"]);
    }
    expect(businessRef(me)).toBe("mission_eats");
  });

  it("a chosen subset is exactly that subset; duplicates are contacted once", () => {
    expect(names(resolveVendors(["Harbor Table", "Golden Grill"], roster))).toEqual(["Harbor Table", "Golden Grill"]);
    expect(names(resolveVendors(["Mission Eats", "mission_eats"], roster))).toEqual(["Mission Eats"]);
  });

  it("unknown, ambiguous and not-ready names resolve to nothing (never a fallback to other vendors)", () => {
    const unknown = resolveVendors(["Mission Eats", "Taco Palace"], roster);
    expect(unknown).toMatchObject({ ok: false, code: "unknown_business", message: expect.stringContaining("Nothing was sent"), fix: expect.stringContaining("Mission Eats (mission_eats)") });
    const amb = resolveVendors(["Bay"], [...roster, { ...roster.find((v) => v.key === "bay_catering")!, key: "bay_bistro", name: "Bay Bistro" }]);
    expect(amb).toMatchObject({ ok: false, code: "ambiguous_business", details: [{ ref: "Bay", candidates: ["Bay Catering", "Bay Bistro"] }] });
    const off = buildRoster(contacts, { ...ON, phone: false });
    expect(resolveVendors(["Mission Eats"], off)).toMatchObject({ ok: false, code: "vendor_not_ready", message: expect.stringContaining("no other vendor was contacted") });
    expect(findVendors("Mission Eats", off).map((v) => v.name)).toEqual(["Mission Eats"]); // profiles still find it
    expect(findVendors("", roster)).toEqual([]);
  });
});
