// workflow/contactWindow.ts: when Haggle may contact a business unprompted. Fake clock (explicit
// instants), America/Los_Angeles, including both DST changes.
import { describe, expect, it } from "vitest";
import {
  addBusinessHours, businessMsBetween, contactWindowFromEnv, decideFirstContact, decideFollowUp, DEFAULT_CONTACT_WINDOW as W, isOpen, localParts, nextOpen, zonedInstant,
} from "../src/workflow/contactWindow.ts";

const LA = "America/Los_Angeles";
/** A Los Angeles wall-clock time as an instant. */
const la = (y: number, m: number, d: number, h: number, min = 0) => zonedInstant(y, m, d, h * 60 + min, LA);
const H = 3_600_000;

describe("the window: Mon–Sat 08:00–19:00 local", () => {
  it("is open on a weekday afternoon, closed at night, on Sunday, and at 19:00 exactly", () => {
    expect(isOpen(la(2026, 10, 21, 14), W, LA)).toBe(true); // Wed
    expect(isOpen(la(2026, 10, 21, 23), W, LA)).toBe(false);
    expect(isOpen(la(2026, 10, 25, 12), W, LA)).toBe(false); // Sun
    expect(isOpen(la(2026, 10, 24, 12), W, LA)).toBe(true); // Sat
    expect(isOpen(la(2026, 10, 21, 19), W, LA)).toBe(false);
    expect(isOpen(la(2026, 10, 21, 8), W, LA)).toBe(true);
  });

  it("an RFQ created at 23:00 waits until 08:00 the next morning; Saturday night waits until Monday", () => {
    expect(nextOpen(la(2026, 10, 21, 23), W, LA)).toEqual(la(2026, 10, 22, 8));
    expect(nextOpen(la(2026, 10, 24, 20), W, LA)).toEqual(la(2026, 10, 26, 8));
    expect(nextOpen(la(2026, 10, 22, 6, 30), W, LA)).toEqual(la(2026, 10, 22, 8));
  });

  it("keeps the local hour across DST: the opening after the spring-forward and fall-back nights is 08:00 local", () => {
    // 2027-03-14: clocks go 02:00 -> 03:00 (PST -> PDT). 2026-11-01: 02:00 -> 01:00 (PDT -> PST).
    const spring = nextOpen(la(2027, 3, 13, 22), W, LA)!; // Sat night -> Mon (Sun closed)
    expect(localParts(spring, LA)).toMatchObject({ d: 15, minute: 8 * 60 });
    expect(spring.toISOString()).toBe("2027-03-15T15:00:00.000Z"); // PDT, UTC-7
    const fall = nextOpen(la(2026, 10, 31, 22), W, LA)!; // Sat night -> Mon Nov 2
    expect(localParts(fall, LA)).toMatchObject({ d: 2, minute: 8 * 60 });
    expect(fall.toISOString()).toBe("2026-11-02T16:00:00.000Z"); // PST, UTC-8
    // A seven-day window over the DST night itself.
    const all = { ...W, days: [0, 1, 2, 3, 4, 5, 6] };
    expect(nextOpen(la(2027, 3, 13, 22), all, LA)!.toISOString()).toBe("2027-03-14T15:00:00.000Z");
    expect(nextOpen(la(2026, 10, 31, 22), all, LA)!.toISOString()).toBe("2026-11-01T16:00:00.000Z");
  });

  it("counts business hours only inside the window (24 business hours ≈ two days and a bit)", () => {
    // Wed 10:00 + 24h: Wed 9h left, Thu 11h, Fri 4h -> Fri 12:00.
    expect(addBusinessHours(la(2026, 10, 21, 10), 24, W, LA)).toEqual(la(2026, 10, 23, 12));
    // From Saturday 17:00: 2h Sat, Sun closed, Mon 11h, Tue 11h -> 24h at Tue 19:00 ... the 24th hour ends at close.
    expect(addBusinessHours(la(2026, 10, 24, 17), 24, W, LA)).toEqual(la(2026, 10, 27, 19));
    // Starting outside the window counts from the next opening.
    expect(addBusinessHours(la(2026, 10, 21, 23), 1, W, LA)).toEqual(la(2026, 10, 22, 9));
    expect(businessMsBetween(la(2026, 10, 21, 18), la(2026, 10, 22, 9), W, LA)).toBe(2 * H);
  });
});

describe("the first RFQ", () => {
  it("in the window: now", () => {
    expect(decideFirstContact(la(2026, 10, 21, 14), la(2026, 10, 23, 12), W, LA)).toEqual({ send: true, reason: "in_window" });
  });
  it("at 23:00 with a reply-by two days out: deferred to 08:00", () => {
    expect(decideFirstContact(la(2026, 10, 21, 23), la(2026, 10, 23, 17), W, LA)).toEqual({ send: false, reason: "outside_window", until: la(2026, 10, 22, 8) });
  });
  it("at 23:00 with a reply-by before the next opening (or too soon after it): sent now, and why", () => {
    const d = decideFirstContact(la(2026, 10, 21, 23), la(2026, 10, 22, 6), W, LA);
    expect(d).toMatchObject({ send: true, reason: "deadline", nextOpen: la(2026, 10, 22, 8) });
    expect((d as { note: string }).note).toMatch(/too little time before the reply-by/);
    // Opening at 08:00, reply-by 09:30: 1.5 business hours < the 2 h minimum.
    expect(decideFirstContact(la(2026, 10, 21, 23), la(2026, 10, 22, 9, 30), W, LA)).toMatchObject({ send: true, reason: "deadline" });
    // A 30-minute collection window (tests, demos) never defers.
    expect(decideFirstContact(la(2026, 10, 21, 23), new Date(la(2026, 10, 21, 23).getTime() + 30 * 60_000), W, LA)).toMatchObject({ send: true, reason: "deadline" });
  });
  it("no reply-by: deferred; a window with no days never opens, so it is sent (and recorded)", () => {
    expect(decideFirstContact(la(2026, 10, 25, 9), null, W, LA)).toEqual({ send: false, reason: "outside_window", until: la(2026, 10, 26, 8) });
    expect(decideFirstContact(la(2026, 10, 25, 9), null, { ...W, days: [] }, LA)).toMatchObject({ send: true, reason: "deadline", nextOpen: null });
  });
});

describe("reminders to a business that hasn't answered", () => {
  const base = { now: la(2026, 10, 23, 12), lastSentAt: la(2026, 10, 21, 10), followUpsSent: 0, suppressed: false, optedOut: false, jobOpen: true, replied: false, deadline: la(2026, 10, 30, 17) };
  it("first one no sooner than 24 business hours after the RFQ, then spaced, at most two", () => {
    expect(decideFollowUp({ ...base, now: la(2026, 10, 23, 11, 59) }, W, LA)).toEqual({ send: false, reason: "too_soon", until: la(2026, 10, 23, 12) });
    expect(decideFollowUp(base, W, LA)).toEqual({ send: true });
    expect(decideFollowUp({ ...base, followUpsSent: 1, lastSentAt: la(2026, 10, 23, 12), now: la(2026, 10, 24, 18) }, W, LA)).toMatchObject({ send: false, reason: "too_soon" });
    expect(decideFollowUp({ ...base, followUpsSent: 2 }, W, LA)).toEqual({ send: false, reason: "max_reached", until: null });
  });
  it("due at night: waits for the next opening (never sends at 23:00)", () => {
    expect(decideFollowUp({ ...base, now: la(2026, 10, 23, 23) }, W, LA)).toEqual({ send: false, reason: "outside_window", until: la(2026, 10, 24, 8) });
  });
  it("never after an opt-out, a suppression, a reply, the job closing, or the reply-by", () => {
    expect(decideFollowUp({ ...base, optedOut: true }, W, LA)).toMatchObject({ send: false, reason: "opted_out", until: null });
    expect(decideFollowUp({ ...base, suppressed: true }, W, LA)).toMatchObject({ reason: "suppressed" });
    expect(decideFollowUp({ ...base, replied: true }, W, LA)).toMatchObject({ reason: "replied" });
    expect(decideFollowUp({ ...base, jobOpen: false }, W, LA)).toMatchObject({ reason: "job_closed" });
    expect(decideFollowUp({ ...base, deadline: la(2026, 10, 23, 11) }, W, LA)).toMatchObject({ reason: "past_deadline" });
    // Due only after the reply-by: never.
    expect(decideFollowUp({ ...base, now: la(2026, 10, 22, 12), deadline: la(2026, 10, 22, 18) }, W, LA)).toMatchObject({ reason: "past_deadline" });
  });
});

describe("configuration", () => {
  it("parses HAGGLE_CONTACT_HOURS / _DAYS / _TIMEZONE; nonsense keeps the default; 'off' disables", () => {
    expect(contactWindowFromEnv({})).toEqual(W);
    expect(contactWindowFromEnv({ HAGGLE_CONTACT_HOURS: "9:30-17", HAGGLE_CONTACT_DAYS: "mon-fri", HAGGLE_CONTACT_TIMEZONE: "America/New_York" })).toMatchObject({ startMinute: 570, endMinute: 1020, days: [1, 2, 3, 4, 5], timezone: "America/New_York" });
    expect(contactWindowFromEnv({ HAGGLE_CONTACT_DAYS: "sat-mon" })!.days).toEqual([0, 1, 6]);
    expect(contactWindowFromEnv({ HAGGLE_CONTACT_HOURS: "19-8", HAGGLE_CONTACT_DAYS: "funday", HAGGLE_CONTACT_TIMEZONE: "Mars/Olympus" })).toEqual(W);
    expect(contactWindowFromEnv({ HAGGLE_CONTACT_HOURS: "off" })).toBeNull();
  });
});
