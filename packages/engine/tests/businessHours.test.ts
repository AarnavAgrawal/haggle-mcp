// Opening hours (Amazon Location components, schema.org on a business's own website), when a business
// may be rung or texted (open, not in its first or last 30 minutes, its own timezone, DST-safe), and
// the engine deferring a call to a closed business. No network.
import { describe, expect, it } from "vitest";
import {
  amazonHours, asWeeklyHours, callSlot, contactableAt, createMockEngine, earliestSlot, extractWebsite, GOLDEN_REQUEST, hoursToday, nextOpenAt, openAt, textSlot, websiteHours,
  type Persona, type WeeklyHours,
} from "../src/index.ts";

const LA = "America/Los_Angeles";
const NY = "America/New_York";
const WEEKDAYS = "FREQ:DAILY;BYDAY:MO,TU,WE,TH,FR";
// 2026-10-19 is a Monday; Pacific Daylight Time (UTC-7) until Sunday 2026-11-01.
const ace = amazonHours([
  { Display: ["Mon-Sun: 06:00 - 14:00"], Components: [{ OpenTime: "T060000", OpenDuration: "PT08H00M", Recurrence: "FREQ:DAILY;BYDAY:MO,TU,WE,TH,FR,SA,SU" }], Categories: [{ Id: "coffee_shop" }] },
  { Display: ["Mon-Fri: 08:00 - 17:00", "Sat: 09:00 - 13:00"], Components: [{ OpenTime: "T080000", OpenDuration: "PT09H00M", Recurrence: WEEKDAYS }, { OpenTime: "T090000", OpenDuration: "PT04H00M", Recurrence: "FREQ:DAILY;BYDAY:SA" }], Categories: [{ Id: "plumbing_service" }] },
], LA, "plumbing_service")!;
const owl = amazonHours([{ Components: [{ OpenTime: "T180000", OpenDuration: "PT10H00M", Recurrence: "FREQ:DAILY;BYDAY:MO,TU,WE,TH,FR,SA,SU" }] }], LA)!;
const at = (iso: string) => new Date(iso);

describe("Amazon Location opening hours", () => {
  it("reads OpenTime / OpenDuration / Recurrence, preferring the entry for the place's primary category", () => {
    expect(ace.timezone).toBe(LA);
    expect(ace.source).toBe("Amazon Location Service");
    expect(ace.display).toEqual(["Mon-Fri: 08:00 - 17:00", "Sat: 09:00 - 13:00"]);
    expect(ace.intervals).toEqual([1, 2, 3, 4, 5].map((day) => ({ day, startMinute: 480, endMinute: 1020 })).concat([{ day: 6, startMinute: 540, endMinute: 780 }]));
  });

  it("an untagged entry wins over another category's; past-midnight durations run into the next day", () => {
    const h = amazonHours([{ Components: [{ OpenTime: "T060000", OpenDuration: "PT01H", Recurrence: WEEKDAYS }], Categories: [{ Id: "cafe" }] }, { Components: [{ OpenTime: "T100000", OpenDuration: "PT02H30M", Recurrence: "FREQ:DAILY;BYDAY:SU" }] }], null, "plumbing_service")!;
    expect(h.intervals).toEqual([{ day: 0, startMinute: 600, endMinute: 750 }]);
    expect(h.timezone).toBeNull();
    expect(owl.intervals[0]).toEqual({ day: 1, startMinute: 1080, endMinute: 1680 });
    expect(owl.intervals).toHaveLength(7);
  });

  it("unreadable components and an invalid timezone are dropped, never guessed", () => {
    expect(amazonHours([{ Components: [{ OpenTime: "noon", OpenDuration: "PT1H", Recurrence: WEEKDAYS }] }], LA)).toBeNull();
    expect(amazonHours(undefined, LA)).toBeNull();
    expect(amazonHours([{ Components: [{ OpenTime: "T090000", OpenDuration: "PT1H", Recurrence: WEEKDAYS }] }], "Mars/Olympus")!.timezone).toBeNull();
  });
});

describe("schema.org hours on the business's own website", () => {
  it("openingHoursSpecification (full day names or schema.org URLs), with a holiday override ignored", () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"Plumber","openingHoursSpecification":[
      {"dayOfWeek":["Monday","https://schema.org/Tuesday"],"opens":"07:00:00","closes":"19:00:00"},
      {"dayOfWeek":"Saturday","opens":"22:00","closes":"02:00"},
      {"dayOfWeek":"Sunday","opens":"00:00","closes":"23:59"},
      {"dayOfWeek":"Friday","opens":"10:00","closes":"11:00","validFrom":"2026-12-24","validThrough":"2026-12-26"}]}]}</script>`;
    const h = websiteHours(html)!;
    expect(h).toMatchObject({ timezone: null, source: "business website" });
    expect(h.intervals).toEqual([
      { day: 1, startMinute: 420, endMinute: 1140 }, { day: 2, startMinute: 420, endMinute: 1140 },
      { day: 6, startMinute: 1320, endMinute: 1560 }, { day: 0, startMinute: 0, endMinute: 1440 },
    ]);
    expect(h.display).toContain("Sun open 24 hours");
  });

  it("openingHours strings and microdata", () => {
    expect(websiteHours(`<script type="application/ld+json">{"@type":"Restaurant","openingHours":["Mo-Fr 11:00-21:30","Sa,Su 12:00-16:00"]}</script>`)!.intervals).toHaveLength(7);
    expect(websiteHours(`<meta itemprop="openingHours" content="Tu-Th 09:00-17:00">`)!.intervals.map((i) => i.day)).toEqual([2, 3, 4]);
  });

  it("broken JSON-LD and pages without hours give nothing; extractWebsite carries the hours", () => {
    expect(websiteHours(`<script type="application/ld+json">{not json</script><p>Open 9 to 5!</p>`)).toBeNull();
    const ev = extractWebsite(`<html><script type="application/ld+json">{"@type":"Plumber","openingHours":"Mo-Fr 08:00-16:00"}</script><p>Call us</p></html>`, "https://bolt.example/");
    expect(ev.hours!.intervals).toHaveLength(5);
    expect(extractWebsite("<p>hi</p>", "https://bolt.example/")).not.toHaveProperty("hours");
  });

  it("stored hours are re-validated (bad intervals dropped, all-bad = unknown)", () => {
    expect(asWeeklyHours({ timezone: LA, intervals: [{ day: 9, startMinute: 0, endMinute: 10 }, { day: 1, startMinute: 600, endMinute: 500 }] })).toBeNull();
    expect(asWeeklyHours({ timezone: "nope", intervals: [{ day: 1, startMinute: 600, endMinute: 700 }], source: "x" })).toMatchObject({ timezone: null, display: ["Mon 10:00–11:40"] });
    expect(asWeeklyHours("Mon 9-5")).toBeNull();
  });
});

describe("open / contactable / next open", () => {
  it("not in the first or last 30 minutes of an opening interval", () => {
    expect(openAt(ace, at("2026-10-19T15:10:00Z"), LA)).toBe(true); // Mon 08:10 PDT: open…
    expect(contactableAt(ace, at("2026-10-19T15:10:00Z"), LA)).toBe(false); // …but just opened
    expect(nextOpenAt(ace, at("2026-10-19T15:10:00Z"), LA)!.toISOString()).toBe("2026-10-19T15:30:00.000Z"); // 08:30 PDT
    expect(contactableAt(ace, at("2026-10-19T20:00:00Z"), LA)).toBe(true); // 13:00
    expect(contactableAt(ace, at("2026-10-19T23:45:00Z"), LA)).toBe(false); // 16:45: closing soon
    expect(nextOpenAt(ace, at("2026-10-19T23:45:00Z"), LA)!.toISOString()).toBe("2026-10-20T15:30:00.000Z"); // Tue 08:30
  });

  it("Saturday's short day, then the weekend; across the end of daylight time the local hour holds", () => {
    expect(nextOpenAt(ace, at("2026-10-24T20:00:00Z"), LA)!.toISOString()).toBe("2026-10-26T15:30:00.000Z"); // Sat 13:00 PDT -> Mon 08:30 PDT
    expect(nextOpenAt(ace, at("2026-10-31T21:00:00Z"), LA)!.toISOString()).toBe("2026-11-02T16:30:00.000Z"); // Sat 14:00 PDT -> Mon 08:30 PST
    expect(nextOpenAt(ace, at("2026-03-07T22:00:00Z"), LA)!.toISOString()).toBe("2026-03-09T15:30:00.000Z"); // Sat PST -> Mon 08:30 PDT (spring forward)
  });

  it("past midnight: open hours carry into the next morning, margins at both real ends only", () => {
    expect(contactableAt(owl, at("2026-10-20T09:00:00Z"), LA)).toBe(true); // Tue 02:00 PDT, Monday's evening shift
    expect(contactableAt(owl, at("2026-10-20T10:45:00Z"), LA)).toBe(false); // 03:45: closing at 04:00
    expect(nextOpenAt(owl, at("2026-10-20T11:10:00Z"), LA)!.toISOString()).toBe("2026-10-21T01:30:00.000Z"); // 04:10 -> 18:30 PDT
    expect(contactableAt(owl, at("2026-10-19T06:59:00Z"), LA)).toBe(true); // Sun night 23:59 into Monday 00:00
  });

  it("open around the clock has no closing margins", () => {
    const always: WeeklyHours = { timezone: LA, intervals: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: 0, endMinute: 1440 })), display: [], source: "x" };
    expect(contactableAt(always, at("2026-10-19T07:00:00Z"), LA)).toBe(true); // midnight
    expect(hoursToday(always, at("2026-10-19T19:00:00Z"), LA)).toBe("Open 24 hours today");
  });

  it("hours without a timezone use the fallback (the workspace's)", () => {
    const site = websiteHours(`<script type="application/ld+json">{"openingHours":"Mo-Fr 09:00-17:00"}</script>`)!;
    expect(contactableAt(site, at("2026-10-19T14:00:00Z"), NY)).toBe(true); // 10:00 EDT
    expect(contactableAt(site, at("2026-10-19T14:00:00Z"), LA)).toBe(false); // 07:00 PDT
  });

  it("'Open today 8am–5pm' in the business's timezone", () => {
    expect(hoursToday(ace, at("2026-10-19T19:00:00Z"), NY)).toBe("Open today 8am–5pm");
    expect(hoursToday(ace, at("2026-10-24T19:00:00Z"), NY)).toBe("Open today 9am–1pm");
    expect(hoursToday(ace, at("2026-10-25T19:00:00Z"), NY)).toBe("Closed today");
    expect(hoursToday(owl, at("2026-10-19T19:00:00Z"), LA)).toBe("Open today 6pm–4am");
  });
});

describe("the contact slot: business hours ∩ the operator's limits", () => {
  const nine5ny: WeeklyHours = { timezone: NY, intervals: [1, 2, 3, 4, 5].map((day) => ({ day, startMinute: 540, endMinute: 1020 })), display: [], source: "x" };
  const callHours = { start: 9, end: 20 };

  it("unknown hours: exactly today's behaviour (call hours only)", () => {
    expect(callSlot(at("2026-10-19T18:00:00Z"), { callHours, timezone: LA })).toBeNull();
    expect(callSlot(at("2026-10-19T10:00:00Z"), { callHours, timezone: LA })!.toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(callSlot(at("2026-10-19T10:00:00Z"), { timezone: LA })).toBeNull();
  });

  it("both must allow it: a New York business closes before the Pacific operator's day ends", () => {
    // 06:00 PDT = 09:00 EDT: the business just opened; call hours start 09:00 PDT (12:00 EDT).
    expect(callSlot(at("2026-10-19T13:00:00Z"), { callHours, timezone: LA, business: nine5ny })!.toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(callSlot(at("2026-10-19T17:00:00Z"), { callHours, timezone: LA, business: nine5ny })).toBeNull(); // 10:00 PDT / 13:00 EDT
    // 14:00 PDT = 17:00 EDT: closed (and its last half hour began 16:30 EDT): next day at 09:00 PDT.
    expect(callSlot(at("2026-10-19T21:00:00Z"), { callHours, timezone: LA, business: nine5ny })!.toISOString()).toBe("2026-10-20T16:00:00.000Z");
    // Friday afternoon -> Monday.
    expect(callSlot(at("2026-10-23T21:00:00Z"), { callHours, timezone: LA, business: nine5ny })!.toISOString()).toBe("2026-10-26T16:00:00.000Z");
  });

  it("no operator call hours: the business's hours alone", () => {
    expect(callSlot(at("2026-10-19T12:00:00Z"), { timezone: LA, business: nine5ny })!.toISOString()).toBe("2026-10-19T13:30:00.000Z"); // 09:30 EDT
  });

  it("hours that never meet the call hours fall back to the call hours (today's behaviour)", () => {
    const nightOnly: WeeklyHours = { timezone: LA, intervals: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, startMinute: 60, endMinute: 240 })), display: [], source: "x" };
    expect(callSlot(at("2026-10-19T10:00:00Z"), { callHours, timezone: LA, business: nightOnly })!.toISOString()).toBe("2026-10-19T16:00:00.000Z");
    expect(earliestSlot(at("2026-10-19T10:00:00Z"), [{ allows: () => false, next: () => null }])).toBeNull();
  });

  it("texts: the business's hours and the contact window", () => {
    const window = { days: [1, 2, 3, 4, 5, 6], startMinute: 8 * 60, endMinute: 19 * 60, minReplyMs: 0, firstFollowUpBusinessHours: 24, followUpGapBusinessHours: 24, maxFollowUps: 2 };
    expect(textSlot(at("2026-10-19T20:00:00Z"), ace, window, LA)).toBeNull(); // Mon 13:00
    expect(textSlot(at("2026-10-19T15:10:00Z"), ace, window, LA)!.toISOString()).toBe("2026-10-19T15:30:00.000Z");
    // Mon 20:00 PDT: the night shop is open, the window (to 19:00) is not; Tue 08:00 it is closed; both allow Tue 18:30.
    expect(textSlot(at("2026-10-20T03:00:00Z"), owl, window, LA)!.toISOString()).toBe("2026-10-21T01:30:00.000Z");
  });
});

describe("the engine waits for a closed business", () => {
  it("a call to a business that is closed now is scheduled for 30 minutes after it opens, then placed", async () => {
    const shop: Persona = { name: "Ace Plumbing & Drain", email: "", phone: "+15105550141", delayMs: 1_000, reply: (t) => (t === "call" ? { text: "Haggle (AI assistant): Hi.\nAce: We're busy, call back." } : null) };
    let t = at("2026-10-19T14:00:00Z").getTime(); // Mon 07:00 PDT: Ace opens at 08:00
    const clock = () => new Date(t);
    const { engine, fleet } = createMockEngine({ now: clock, personas: [shop] });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, budget_usd, reply_by: "2026-10-21T10:00:00Z", businesses: [{ name: shop.name, phone: shop.phone!, opening_hours: ace }] });
    expect(fleet.calls).toHaveLength(0);
    expect(deal.not_contacted).toEqual([expect.objectContaining({ business: shop.name, reason: expect.stringMatching(/call scheduled for 2026-10-19T15:30:00/) })]);
    t = at("2026-10-19T15:20:00Z").getTime(); // 08:20: open, but not yet 30 minutes
    await engine.waitForUpdate(deal.job_id, 0, 0);
    expect(fleet.calls).toHaveLength(0);
    t = at("2026-10-19T15:30:30Z").getTime();
    await engine.waitForUpdate(deal.job_id, 0, 0);
    expect(fleet.calls).toHaveLength(1);
  });

  it("without hours nothing changes: the call goes at once", async () => {
    const shop: Persona = { name: "Night Shop", email: "", phone: "+15105550188", delayMs: 1_000, reply: () => null };
    const { engine, fleet } = createMockEngine({ now: () => at("2026-10-19T10:00:00Z"), personas: [shop] });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    await engine.deal({ request, budget_usd, reply_by: "2026-10-21T10:00:00Z", businesses: [{ name: shop.name, phone: shop.phone! }] });
    expect(fleet.calls).toHaveLength(1);
  });
});
