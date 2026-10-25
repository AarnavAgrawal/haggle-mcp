// Readiness (src/health.ts): database, migration ledger, providers, AI usage and stalled jobs, with
// fakes. Output carries no secret, URL or address, and a runtime failure's text is never echoed.
import { describe, expect, it, vi } from "vitest";
import { AiUsageMeter, findMigrationsDir, repoMigrations, StalledJobMonitor } from "@haggle/engine";
import { migrationsCheck, readiness, type RuntimeOps } from "../src/health.ts";

const files = repoMigrations(findMigrationsDir(import.meta.dirname)!);
const engineFiles = files.filter((f) => /^1\d\d_engine_/.test(f.name));
const at = "2026-10-22T00:00:00.000Z";
const ledgerOf = (list: typeof files): { name: string; checksum: string | null; applied_at: string }[] => list.map((f) => ({ name: f.name, checksum: f.checksum, applied_at: at }));
const LIVE_ENV = { HAGGLE_MODE: "live", HAGGLE_ENV: "staging", INKBOX_API_KEY: "ik_SECRETVALUE", INKBOX_WEBHOOK_SECRET: "whsec_SECRETVALUE", ANTHROPIC_API_KEY: "sk-ant-SECRETVALUE", SUPABASE_DB_URL: "postgres://postgres.devref:hunter2pw@aws-0.pooler.supabase.com:5432/postgres" };

function ops(over: Partial<RuntimeOps> & { ledger?: ReturnType<typeof ledgerOf> | null; dbDown?: boolean } = {}): RuntimeOps {
  const { ledger = ledgerOf(engineFiles), dbDown = false, ...rest } = over;
  return {
    env: "staging", database: "postgres",
    repo: { listRecentJobs: async () => { if (dbDown) throw new Error("connect ECONNREFUSED postgres://u:hunter2pw@db"); return []; }, listAppliedMigrations: async () => ledger },
    providers: { inkbox: true, anthropic: true, payments: "manual", alerts: false },
    ...rest,
  };
}

describe("/ready", () => {
  it("ready when config, database, every engine migration and providers check out; AI usage and stalled jobs shown", async () => {
    const ai = new AiUsageMeter({ limits: { dailyTokenBudget: 1000 } });
    ai.record({}, { input_tokens: 100, output_tokens: 20 });
    const stalled = new StalledJobMonitor({ repo: { listOpenJobs: async () => [], getPendingMessages: async () => [] } });
    await stalled.check();
    const r = await readiness({ mode: "live", ops: ops({ ai, stalled }) }, LIVE_ENV);
    expect(r.ready).toBe(true);
    expect(r.checks.migrations).toMatchObject({ ok: true, ledger: "present", applied: engineFiles.length, pending: [], drift: [] });
    expect(r.checks.ai).toMatchObject({ ok: true, metered: true, tokens_in: 100, tokens_out: 20, daily_tokens_remaining: 880 });
    expect(r.checks.stalled_jobs).toMatchObject({ ok: true, monitored: true, count: 0 });
    expect(JSON.stringify(r)).not.toMatch(/SECRETVALUE|hunter2pw|devref|postgres:\/\//);
  });

  it("not ready without the ledger, with a pending engine migration, with drift, or with an unverified row", async () => {
    expect((await readiness({ mode: "live", ops: ops({ ledger: null }) }, LIVE_ENV)).checks.migrations).toMatchObject({ ok: false, ledger: "absent" });
    const pending = await migrationsCheck(ops({ ledger: ledgerOf(engineFiles.slice(1)) }), files);
    expect(pending).toMatchObject({ ok: false, pending: [engineFiles[0]!.name] });
    const drift = await migrationsCheck(ops({ ledger: ledgerOf(engineFiles).map((r, i) => (i === 0 ? { ...r, checksum: "0".repeat(64) } : r)) }), files);
    expect(drift).toMatchObject({ ok: false, drift: [engineFiles[0]!.name] });
    const unverified = await migrationsCheck(ops({ ledger: ledgerOf(engineFiles).map((r) => (r.name === "111_engine_ops.sql" ? { ...r, checksum: null } : r)) }), files);
    expect(unverified).toMatchObject({ ok: false, unverified: ["111_engine_ops.sql"] });
    // The brain's 2xx files are Aarnav's: missing from the engine ledger doesn't block readiness.
    expect((await migrationsCheck(ops(), files)).ok).toBe(true);
  });

  it("an unreachable database is reported without the driver's error text", async () => {
    const r = await readiness({ mode: "live", ops: ops({ dbDown: true }) }, LIVE_ENV);
    expect(r.ready).toBe(false);
    expect(r.checks.database).toEqual({ ok: false, kind: "postgres", reason: "unreachable" });
    expect(r.checks.migrations).toMatchObject({ ok: false, reason: "database_unreachable" });
    expect(JSON.stringify(r)).not.toMatch(/hunter2pw|ECONNREFUSED/);
  });

  it("a refused configuration or failed runtime is not ready, names variables only, never echoes the error", async () => {
    const r = await readiness({ mode: "live", ops: null, runtimeError: new Error("Inkbox 401 for key ik_SECRETVALUE owner ops@acme.example") }, { HAGGLE_MODE: "live", HAGGLE_ENV: "production", ANTHROPIC_API_KEY: "sk-ant-SECRETVALUE" });
    expect(r.ready).toBe(false);
    expect(r.checks.config).toMatchObject({ ok: false });
    expect(r.checks.config.problems).toContain("INKBOX_API_KEY is required in live mode");
    expect(JSON.stringify(r)).not.toMatch(/SECRETVALUE|ops@acme|Inkbox 401/);
    const started = await readiness({ mode: "live", ops: null, runtimeError: new Error("Inkbox down") }, LIVE_ENV);
    expect(started.checks.config).toMatchObject({ ok: false, runtime: "failed to start (see the server log)" });
  });

  it("a spent AI budget shows but doesn't make the server unready (replies wait for humans)", async () => {
    const ai = new AiUsageMeter({ limits: { dailyTokenBudget: 10 } });
    ai.record({}, { input_tokens: 50, output_tokens: 0 });
    const r = await readiness({ mode: "live", ops: ops({ ai }) }, LIVE_ENV);
    expect(r.ready).toBe(true);
    expect(r.checks.ai).toMatchObject({ daily_budget_reached: true, daily_tokens_remaining: 0 });
  });

  it("mock servers: memory database, ledger not applicable", async () => {
    const r = await readiness({ mode: "mock", ops: { env: "development", database: "memory", repo: { listRecentJobs: async () => [] }, providers: { inkbox: false, anthropic: false, payments: "disabled", alerts: false } } }, {});
    expect(r).toMatchObject({ ready: true, mode: "mock", env: "development", checks: { migrations: { ok: true, ledger: "not_applicable" } } });
  });
});

describe("/ready under a database outage and a database ahead of the build", () => {
  it("a database whose queries hang is unready within the 3 s budget, reason only", async () => {
    vi.useFakeTimers();
    try {
      const hanging: RuntimeOps = { ...ops(), repo: { listRecentJobs: () => new Promise(() => {}), listAppliedMigrations: () => new Promise(() => {}) } };
      const p = readiness({ mode: "live", ops: hanging }, LIVE_ENV);
      await vi.advanceTimersByTimeAsync(3_100);
      const r = await p;
      expect(r.ready).toBe(false);
      expect(r.checks.database).toEqual({ ok: false, kind: "postgres", reason: "unreachable" });
      expect(r.checks.migrations).toMatchObject({ ok: false, reason: "database_unreachable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a ledger read that hangs after the database answered is reported as ledger_unreadable", async () => {
    vi.useFakeTimers();
    try {
      const slowLedger: RuntimeOps = { ...ops(), repo: { listRecentJobs: async () => [], listAppliedMigrations: () => new Promise(() => {}) } };
      const p = readiness({ mode: "live", ops: slowLedger }, LIVE_ENV);
      await vi.advanceTimersByTimeAsync(3_100);
      expect((await p).checks.migrations).toEqual({ ok: false, reason: "ledger_unreadable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an engine migration the build doesn't know is reported (database_ahead) but doesn't fail readiness (rollback)", async () => {
    const ahead = [...ledgerOf(engineFiles), { name: "199_engine_from_the_future.sql", checksum: "a".repeat(64), applied_at: at }];
    expect(await migrationsCheck(ops({ ledger: ahead }), files)).toMatchObject({ ok: true, unexpected: ["199_engine_from_the_future.sql"], database_ahead: true });
    expect(await migrationsCheck(ops(), files)).toMatchObject({ ok: true, unexpected: [] });
  });
});

describe("/ready: the brain's schema (202_brain_tenancy is outside the engine ledger)", () => {
  it("a store without 202 makes the server unready, says which migration to apply, and leaks nothing", async () => {
    const r = await readiness({ mode: "live", ops: ops({ brain: { checkSchema: async () => ({ ok: false, reason: "schema_missing" }) } }) }, LIVE_ENV);
    expect(r.ready).toBe(false);
    expect(r.checks.brain).toEqual({ ok: false, reason: "schema_missing", fix: expect.stringMatching(/202_brain_tenancy\.sql/) });
    expect(JSON.stringify(r)).not.toMatch(/SECRETVALUE|hunter2pw|devref|postgres:\/\/|supabase\.co/);
  });

  it("schema present: ready, brain ok; unreachable or throwing: unready with a reason only", async () => {
    expect((await readiness({ mode: "live", ops: ops({ brain: { checkSchema: async () => ({ ok: true }) } }) }, LIVE_ENV)).checks.brain).toEqual({ ok: true, schema: "ok" });
    expect((await readiness({ mode: "live", ops: ops({ brain: { checkSchema: async () => ({ ok: true }) } }) }, LIVE_ENV)).ready).toBe(true);
    expect((await readiness({ mode: "live", ops: ops({ brain: { checkSchema: async () => ({ ok: false, reason: "unreachable" }) } }) }, LIVE_ENV)).checks.brain).toEqual({ ok: false, reason: "unreachable" });
    const thrown = await readiness({ mode: "live", ops: ops({ brain: { checkSchema: async () => { throw new Error("https://devref.supabase.co hunter2pw"); } } }) }, LIVE_ENV);
    expect(thrown.checks.brain).toEqual({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(thrown)).not.toMatch(/hunter2pw|devref/);
  });

  it("a probe that hangs is unready within the 3 s budget", async () => {
    vi.useFakeTimers();
    try {
      const p = readiness({ mode: "live", ops: ops({ brain: { checkSchema: () => new Promise(() => {}) } }) }, LIVE_ENV);
      await vi.advanceTimersByTimeAsync(3_100);
      expect((await p).checks.brain).toEqual({ ok: false, reason: "timed_out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("no schema to check (memory or file brain): not applicable, ok", async () => {
    expect((await readiness({ mode: "live", ops: ops() }, LIVE_ENV)).checks.brain).toEqual({ ok: true, schema: "not_applicable" });
  });
});
