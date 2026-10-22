// Sprint 5 A: dates a purchase depends on. Plain-language days ("tomorrow", "Saturday") resolve on the
// workspace's calendar (America/Los_Angeles by default), not UTC, including around midnight and the
// DST change; the simulated fleet's quotes are dated from when they're given (a fixed valid-until made
// every demo quote stale from 2026-10-22). Pure functions plus one mock-mode deal; nothing is real.
import { describe, expect, it } from "vitest";
import { createMockEngine, fleetBusinesses, GOLDEN_REQUEST, localDate, normalizePlainRequest, simValidUntil } from "../src/index.ts";

const at = (iso: string) => new Date(iso);

describe("localDate: today on the workspace's calendar", () => {
  it("late evening in San Francisco is still today there, though UTC has moved on", () => {
    expect(localDate(at("2026-10-23T06:30:00Z"))).toBe("2026-10-22"); // 11:30 pm PDT
    expect(localDate(at("2026-10-23T07:30:00Z"))).toBe("2026-10-23"); // 12:30 am PDT
    expect(localDate(at("2026-10-23T06:30:00Z"), "UTC")).toBe("2026-10-23");
    expect(localDate(at("2026-10-23T06:30:00Z"), "America/New_York")).toBe("2026-10-23");
  });
  it("across the DST change (Nov 1, 2026) the local midnight moves with it", () => {
    expect(localDate(at("2026-11-01T06:59:00Z"))).toBe("2026-10-31"); // 11:59 pm PDT
    expect(localDate(at("2026-11-01T07:01:00Z"))).toBe("2026-11-01"); // 12:01 am PDT
    expect(localDate(at("2026-11-02T07:59:00Z"))).toBe("2026-11-01"); // 11:59 pm PST
    expect(localDate(at("2026-11-02T08:01:00Z"))).toBe("2026-11-02"); // 12:01 am PST
  });
  it("an unknown or empty timezone falls back to the pilot's", () => {
    expect(localDate(at("2026-10-23T06:30:00Z"), "Not/AZone")).toBe("2026-10-22");
    expect(localDate(at("2026-10-23T06:30:00Z"), null)).toBe("2026-10-22");
  });
});

describe("plain-language days read from the local date", () => {
  it("'tomorrow' at 10:30 pm in San Francisco is the next local day, not two days out", () => {
    const now = at("2026-10-23T05:30:00Z"); // Thu Oct 22, 10:30 pm PDT
    expect(normalizePlainRequest({ when: "tomorrow at noon" }, localDate(now)).date).toBe("2026-10-23");
    expect(normalizePlainRequest({ when: "tomorrow at noon" }, now.toISOString().slice(0, 10)).date).toBe("2026-10-24"); // the UTC bug
  });
  it("'Saturday' said Friday evening means tomorrow, not the Saturday after", () => {
    const now = at("2026-10-24T03:00:00Z"); // Fri Oct 23, 8:00 pm PDT
    expect(normalizePlainRequest({ when: "Saturday at 11:30am" }, localDate(now))).toMatchObject({ date: "2026-10-24", time: "11:30" });
    expect(normalizePlainRequest({ when: "Saturday at 11:30am" }, now.toISOString().slice(0, 10)).date).toBe("2026-10-31"); // the UTC bug
  });
  it("'Nov 1' asked just after local midnight on Nov 1 is today, not next year", () => {
    const now = at("2026-11-01T07:30:00Z"); // Sun Nov 1, 12:30 am PDT
    expect(normalizePlainRequest({ when: "Nov 1" }, localDate(now)).date).toBe("2026-11-01");
    expect(normalizePlainRequest({ when: "Oct 31" }, localDate(now)).date).toBe("2027-10-31");
  });
});

describe("simulated quotes are dated from when they're given", () => {
  it("simValidUntil is 14 days on", () => {
    expect(simValidUntil(Date.parse("2026-10-22T16:00:00Z"))).toBe("2026-11-05");
  });
  it("a mock deal's quotes today aren't stale (they were, with the fixed 2026-10-21)", { timeout: 60_000 }, async () => {
    let t = Date.now();
    const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
    const { engine } = createMockEngine({ now: clock.now, config: { globalPaymentCapCents: 1_000_000 } });
    const { budget_usd, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request: { ...request, date: new Date(t + 21 * 86_400_000).toISOString().slice(0, 10) }, budget_usd, businesses: fleetBusinesses().filter((b) => b.email).map((b) => ({ name: b.name, email: b.email!, simulated: true })) });
    let board = await engine.getQuotes(deal.job_id);
    for (let i = 0; i < 60 && board.quotes.filter((q) => q.total_usd !== null).length < 2; i++) {
      clock.advance(5_000);
      await engine.waitForUpdate(deal.job_id, 0, 0);
      board = await engine.getQuotes(deal.job_id);
    }
    const priced = board.quotes.filter((q) => q.total_usd !== null);
    expect(priced.length).toBeGreaterThanOrEqual(2);
    for (const q of priced) {
      expect(q.freshness?.stale).toBe(false);
      expect(q.freshness?.valid_until! > new Date(t).toISOString().slice(0, 10)).toBe(true);
    }
  });
});
