// Shared fixed-window rate slots (Repository.takeRateSlot; migration 124 take_rate_slot): the window
// is aligned to the epoch (86400 s = the UTC day), a refused take doesn't count, keys and buckets are
// independent. The in-memory store has the same maths; on Postgres, two repositories (two connection
// pools, standing in for two server processes) share one budget. Run on Postgres by scripts/test-postgres.sh.
import { describe, expect, it } from "vitest";
import { InMemoryRepository, PostgresRepository } from "../src/index.ts";

describe("rate slots (in memory)", () => {
  it("grants up to max per window, then refuses with the seconds until the window ends", async () => {
    let t = new Date("2026-10-22T23:59:30Z");
    const repo = new InMemoryRepository({ now: () => t });
    for (let i = 1; i <= 3; i++) expect(await repo.takeRateSlot("vendor_adds", "ws_a", 86_400, 3)).toEqual({ allowed: true, used: i, retryAfterS: 0 });
    expect(await repo.takeRateSlot("vendor_adds", "ws_a", 86_400, 3)).toEqual({ allowed: false, used: 3, retryAfterS: 30 });
    expect(await repo.rateSlotUsed("vendor_adds", "ws_a", 86_400)).toBe(3);
    // A refused take doesn't count; the next UTC day starts a new window.
    t = new Date("2026-10-23T00:00:00Z");
    expect(await repo.rateSlotUsed("vendor_adds", "ws_a", 86_400)).toBe(0);
    expect(await repo.takeRateSlot("vendor_adds", "ws_a", 86_400, 3)).toMatchObject({ allowed: true, used: 1 });
  });

  it("keys and buckets are independent", async () => {
    const repo = new InMemoryRepository({ now: () => new Date("2026-10-22T12:00:00Z") });
    expect((await repo.takeRateSlot("b1", "k1", 60, 1)).allowed).toBe(true);
    expect((await repo.takeRateSlot("b1", "k1", 60, 1)).allowed).toBe(false);
    expect((await repo.takeRateSlot("b1", "k2", 60, 1)).allowed).toBe(true);
    expect((await repo.takeRateSlot("b2", "k1", 60, 1)).allowed).toBe(true);
  });

  it("rejects a bad window or max (as the SQL function does)", async () => {
    const repo = new InMemoryRepository();
    await expect(repo.takeRateSlot("b", "k", 0, 1)).rejects.toThrow(/window/);
    await expect(repo.takeRateSlot("b", "k", 60, 0)).rejects.toThrow(/max/);
    await expect(repo.takeRateSlot("", "k", 60, 1)).rejects.toThrow(/bucket/);
  });

  it("stays bounded: expired windows are dropped as keys pile up", async () => {
    let t = new Date("2026-10-22T12:00:00Z");
    const repo = new InMemoryRepository({ now: () => t });
    for (let i = 0; i < 12_000; i++) await repo.takeRateSlot("b", `k${i}`, 60, 1);
    t = new Date("2026-10-22T12:05:00Z");
    // The next sweep runs once the map has doubled since the last one; it drops the 12,000 finished windows.
    for (let i = 0; i < 9_000; i++) await repo.takeRateSlot("b", `fresh${i}`, 60, 1);
    expect((repo as unknown as { rateSlots: Map<string, unknown> }).rateSlots.size).toBeLessThanOrEqual(9_000);
    expect(await repo.rateSlotUsed("b", "fresh0", 60)).toBe(1);
  });
});

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("rate slots on Postgres (two instances)", { timeout: 60_000 }, () => {
  const uniq = () => Math.random().toString(36).slice(2, 10);

  it("two repositories share one budget; concurrent takes never overshoot", async () => {
    const [p1, p2] = [new PostgresRepository(PG_URL!), new PostgresRepository(PG_URL!)];
    try {
      const key = `ws_${uniq()}`;
      const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? p1 : p2).takeRateSlot("vendor_adds", key, 86_400, 25)));
      expect(results.filter((r) => r.allowed)).toHaveLength(25);
      const refused = results.filter((r) => !r.allowed);
      expect(refused).toHaveLength(15);
      expect(refused.every((r) => r.used === 25 && r.retryAfterS > 0 && r.retryAfterS <= 86_400)).toBe(true);
      expect(await p1.rateSlotUsed("vendor_adds", key, 86_400)).toBe(25);
      expect(await p2.rateSlotUsed("vendor_adds", `ws_${uniq()}`, 86_400)).toBe(0);
      expect((await p2.takeRateSlot("other_bucket", key, 86_400, 25)).allowed).toBe(true);
    } finally {
      await Promise.all([p1.close(), p2.close()]);
    }
  });

  it("the database refuses a bad window or max", async () => {
    const p = new PostgresRepository(PG_URL!);
    try {
      await expect(p.takeRateSlot("b", "k", 0, 1)).rejects.toThrow();
      await expect(p.takeRateSlot("b", "k", 60, 0)).rejects.toThrow();
    } finally {
      await p.close();
    }
  });
});
