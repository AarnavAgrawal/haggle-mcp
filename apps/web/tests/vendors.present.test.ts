// The vendors page's presentation helpers (lib/vendors/present.ts). Pure functions; no network.
import { describe, expect, it } from "vitest";
import { applyVendorChange, basisLabel, canonName, channelLabel, clockWords, consentParts, displayContact, hoursToday, hoursWords, searchOutcome } from "../lib/vendors/present.ts";
import type { VendorView } from "../lib/vendors/types.ts";

const vendor = (name: string, contact: string): VendorView => ({
  name, contact, channel: "email", consent: { basis: "business_agreed", text: "Owner said yes" }, added_by: "me", added_at: "2026-10-01T10:00:00Z", contactable: true,
});
// 2026-10-28 is a Wednesday; 2026-11-01 a Sunday (local time).
const WED = new Date(2026, 9, 28, 12, 0);
const SUN = new Date(2026, 10, 1, 12, 0);

describe("words", () => {
  it("names channels and consent bases plainly, never as codes", () => {
    expect(channelLabel("imessage")).toBe("Text");
    expect(channelLabel("phone")).toBe("Phone call");
    expect(channelLabel("carrier_pigeon")).toBe("Other");
    expect(basisLabel("public_listing_email")).toBe("Public listing, email only");
    expect(basisLabel("operator_recorded")).toBe("Recorded by your admin");
    expect(basisLabel("unknown_basis")).toBe("Recorded");
  });

  it("formats contacts for reading", () => {
    expect(displayContact("+14155550123")).toBe("(415) 555-0123");
    expect(displayContact("+442079460958")).toBe("+442079460958");
    expect(displayContact("orders@baycatering.com")).toBe("orders@baycatering.com");
  });
});

describe("consentParts", () => {
  it("reads the stored consent without the internal actor id", () => {
    expect(consentParts("business_agreed: Maria, the owner, by phone (attested by web:4ee1fb1f-c127 at 2026-10-31T07:26:23.622Z)")).toEqual({ note: "Maria, the owner, by phone", confirmedAt: "2026-10-31T07:26:23.622Z", raw: null });
    expect(consentParts("business_agreed (attested by web:4ee1 at 2026-10-31T07:26:23.622Z)")).toEqual({ note: null, confirmedAt: "2026-10-31T07:26:23.622Z", raw: null });
    expect(consentParts("Signed contract on file, 2025")).toEqual({ note: null, confirmedAt: null, raw: "Signed contract on file, 2025" });
  });
});

describe("hours", () => {
  it("reads 24-hour clock times as AM/PM", () => {
    expect(clockWords("09:00")).toBe("9 AM");
    expect(clockWords("17:30")).toBe("5:30 PM");
    expect(clockWords("00:00")).toBe("12 AM");
    expect(clockWords("24:00")).toBe("midnight");
    expect(hoursWords("09:00–17:00")).toBe("9 AM–5 PM");
    expect(hoursWords("open 24 hours")).toBe("Open 24 hours");
  });

  it("finds today's line in the stored weekly hours (single days and ranges, wrapping weeks)", () => {
    const lines = ["Mon 09:00–17:00", "Wed 08:00–12:00", "Wed 13:00–18:00", "Fri 10:00–14:00"];
    expect(hoursToday(lines, WED)).toBe("8 AM–12 PM, 1 PM–6 PM");
    expect(hoursToday(lines, SUN)).toBe("Closed today");
    expect(hoursToday(["Mon-Fri: 09:00 - 17:00", "Sat: 10:00 - 14:00"], WED)).toBe("9 AM–5 PM");
    expect(hoursToday(["Fri-Mon: 10:00 - 22:00"], SUN)).toBe("10 AM–10 PM");
    expect(hoursToday(["Sun open 24 hours"], SUN)).toBe("Open 24 hours");
  });

  it("says nothing when the hours are unknown or unreadable", () => {
    expect(hoursToday(undefined, WED)).toBeNull();
    expect(hoursToday([], WED)).toBeNull();
    expect(hoursToday(["By appointment"], WED)).toBeNull();
    expect(hoursToday(["Mon 09:00–17:00", "Holidays vary"], WED)).toBeNull();
  });
});

describe("optimistic list changes", () => {
  const list = [vendor("Bay Catering", "orders@bay.com"), vendor("Golden Grill", "+14155550123")];

  it("puts an added vendor last (the server's order), replacing one with the same contact in place", () => {
    const added = applyVendorChange(list, { type: "add", vendor: vendor("Casa Lunch", "hi@casa.com") });
    expect(added.map((v) => v.name)).toEqual(["Bay Catering", "Golden Grill", "Casa Lunch"]);
    const again = applyVendorChange(list, { type: "add", vendor: vendor("Bay Catering Co", "orders@bay.com") });
    expect(again.map((v) => v.name)).toEqual(["Bay Catering Co", "Golden Grill"]);
    expect(list).toHaveLength(2); // never mutates
  });

  it("drops a removed vendor by contact", () => {
    expect(applyVendorChange(list, { type: "remove", contact: "+14155550123" }).map((v) => v.name)).toEqual(["Bay Catering"]);
    expect(applyVendorChange(list, { type: "remove", contact: "nobody@x.com" })).toHaveLength(2);
  });

  it("explains an empty search by its cause, without operator details", () => {
    const asked = { category: "caterer", area: "Oakland" };
    expect(searchOutcome("ok", "0 found", asked)).toEqual({ title: "Nothing found for caterer near Oakland.", body: "Try a broader kind of business, or a nearby city.", next: null });
    const off = searchOutcome("not_configured", "no listing key is set (AWS_LOCATION_API_KEY)", asked);
    expect(off.next).toBe("add");
    expect(JSON.stringify(off)).not.toContain("AWS_LOCATION_API_KEY");
    expect(searchOutcome("no_area", "", { category: "plumber", area: "" }).next).toBe("area");
    expect(searchOutcome("rate_limited", "", asked).next).toBe("retry");
    expect(searchOutcome("something_new", "Listings are paused.", { category: "plumber", area: "" })).toMatchObject({ title: "Nothing found for plumber.", body: "Listings are paused." });
  });

  it("compares business names loosely", () => {
    expect(canonName("Bay Catering, Inc.")).toBe(canonName("bay catering inc"));
  });
});
