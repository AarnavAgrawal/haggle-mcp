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
    expect(off.find((v) => v.key === "sunset_kitchen")).toMatchObject({ ready: false, blocker: "iMessage outreach is off on this server", fix: expect.stringContaining("HAGGLE_ENABLE_IMESSAGE=true") });
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
