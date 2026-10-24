// Board polling vs the database pool (store/poolGate.ts): with a fake slow database that behaves like
// postgres.js (lazy queries, executed on then), a crowd of wait_for_update-style pollers never has more
// than `max` queries in flight, waiters past the queue timeout fail as transient instead of piling up,
// and every slot is released. Then the same on a real Postgres (PG-gated): connections never exceed
// the pool size and fragments still work.
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { gatedSql, isTransient, PoolBusyError, PoolGate, PostgresRepository } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A postgres.js-shaped fake: sql`...` returns a lazy thenable; running ones are counted. */
function fakeDb(queryMs: number) {
  const s = { running: 0, peak: 0, executed: 0 };
  const sql = (strings: TemplateStringsArray | object, ..._args: unknown[]) => {
    if (!Array.isArray(strings)) return { helper: strings };
    let p: Promise<unknown> | null = null;
    const start = () => (p ??= (async () => { s.running++; s.peak = Math.max(s.peak, s.running); s.executed++; await sleep(queryMs); s.running--; return [{ ok: 1 }]; })());
    return { strings, then: (ok?: (v: unknown) => unknown, fail?: (e: unknown) => unknown) => start().then(ok, fail) };
  };
  (sql as unknown as { begin: unknown }).begin = async (fn: (tx: unknown) => Promise<unknown>) => { s.running++; s.peak = Math.max(s.peak, s.running); try { await sleep(queryMs); return await fn(sql); } finally { s.running--; } };
  return { sql: sql as unknown as ((s: TemplateStringsArray, ...a: unknown[]) => PromiseLike<unknown>) & { begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> }, s };
}

describe("pool gate", () => {
  it("a crowd of pollers never exceeds the pool; slow waiters fail as transient, then all slots come back", async () => {
    const { sql, s } = fakeDb(15);
    const gate = new PoolGate(4, 150, 1_000);
    const db = gatedSql(sql, gate);
    // 60 boards polling like wait_for_update: three reads per iteration, then a short sleep.
    let ok = 0;
    const errors: unknown[] = [];
    const poller = async () => {
      for (let i = 0; i < 4; i++) {
        try {
          await db`select 1`; await db`select 2`; await db`select 3`;
          ok++;
        } catch (e) { errors.push(e); }
        await sleep(10);
      }
    };
    await Promise.all(Array.from({ length: 60 }, poller));
    expect(s.peak).toBeLessThanOrEqual(4);
    expect(gate.stats()).toMatchObject({ max: 4, in_use: 0, queued: 0, peak_in_use: 4 });
    expect(gate.stats().timeouts).toBe(errors.length);
    expect(errors.length).toBeGreaterThan(0); // 60 pollers x 15 ms on 4 slots can't all fit in 150 ms
    for (const e of errors) { expect(e).toBeInstanceOf(PoolBusyError); expect(isTransient(e)).toBe(true); }
    expect(ok + errors.length).toBe(240);
  });

  it("control: without the gate the same crowd runs unbounded (the fake really is concurrent)", async () => {
    const { sql, s } = fakeDb(15);
    await Promise.all(Array.from({ length: 60 }, () => sql`select 1`));
    expect(s.peak).toBe(60);
  });

  it("a generous queue timeout serves everyone, still never more than max at once", async () => {
    const { sql, s } = fakeDb(5);
    const gate = new PoolGate(3, 10_000);
    const db = gatedSql(sql, gate);
    await Promise.all(Array.from({ length: 50 }, () => db`select 1`));
    expect(s).toMatchObject({ peak: 3, executed: 50, running: 0 });
    expect(gate.stats()).toMatchObject({ in_use: 0, timeouts: 0, rejected: 0 });
  });

  it("transactions hold a slot; a full queue is refused at once; fragments and helpers are never gated or run", async () => {
    const { sql, s } = fakeDb(20);
    const gate = new PoolGate(1, 5_000, 2);
    const db = gatedSql(sql, gate);
    const tx = db.begin(async () => "done");
    const q1 = db`select 1`;
    const q2 = db`select 2`;
    const fragment = db`now()`; // never awaited: nothing runs, no slot taken
    const helper = (db as unknown as (o: object) => unknown)({ a: 1 });
    const pending = [Promise.resolve(q1), Promise.resolve(q2)];
    await sleep(0);
    expect(gate.stats()).toMatchObject({ in_use: 1, queued: 2 });
    await expect(Promise.resolve(db`select 3`)).rejects.toThrow(/queue full/);
    expect(await tx).toBe("done");
    await Promise.all(pending);
    expect(s.executed).toBe(2);
    expect((fragment as unknown as { strings: string[] }).strings[0]).toBe("now()");
    expect(helper).toEqual({ helper: { a: 1 } });
    expect(gate.stats()).toMatchObject({ in_use: 0, queued: 0, rejected: 1 });
  });

  it("a query that fails releases its slot", async () => {
    const gate = new PoolGate(1, 1_000);
    const failing = ((..._a: unknown[]) => ({ then: (_ok: unknown, fail?: (e: unknown) => unknown) => Promise.reject(new Error("boom")).then(undefined, fail) })) as unknown as (s: TemplateStringsArray) => PromiseLike<unknown>;
    const db = gatedSql(failing, gate);
    await expect(Promise.resolve(db`select 1`)).rejects.toThrow("boom");
    await expect(Promise.resolve(db`select 1`)).rejects.toThrow("boom");
    expect(gate.stats()).toMatchObject({ in_use: 0, queued: 0 });
  });
});

const URL_ = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!URL_)("pool gate on Postgres", () => {
  const app = `haggle-pooltest-${process.pid}`;
  const repo = URL_ ? new PostgresRepository(URL_, { max: 2, applicationName: app, queueTimeoutMs: 20_000 }) : null!;
  const admin = URL_ ? postgres(URL_, { max: 1, onnotice: () => {} }) : null!;
  afterAll(async () => { await repo?.close(); await admin?.end({ timeout: 5 }); });

  it("60 concurrent board reads use at most 2 connections and all succeed", async () => {
    let peak = 0;
    let stop = false;
    const watch = (async () => {
      while (!stop) {
        const rows = await admin<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where application_name = ${app}`;
        peak = Math.max(peak, rows[0]?.n ?? 0);
        await sleep(5);
      }
    })();
    const reads = await Promise.all(Array.from({ length: 60 }, (_, i) => (i % 2 ? repo.listRecentJobs(5) : repo.listEvents(`job_none_${i}`, 0))));
    stop = true;
    await watch;
    expect(reads).toHaveLength(60);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    expect(repo.poolStats()).toMatchObject({ max: 2, in_use: 0, queued: 0, timeouts: 0 });
    expect(repo.poolStats().peak_in_use).toBe(2);
  });
});
