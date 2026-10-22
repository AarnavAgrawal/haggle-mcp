// The launch gate (scripts/launch-gate.ts) with fakes: every failing prerequisite makes it fail,
// warnings don't, nothing reads .env by default, and no value, URL or key reaches its output.
import { describe, expect, it } from "vitest";
import { findMigrationsDir, isEngineMigration, repoMigrations, type LedgerRow } from "@haggle/engine";
import { formatGate, parseEnvFile, parseGateArgs, runLaunchGate, type GateDeps, type GateOptions } from "../scripts/launch-gate.ts";

const DIR = findMigrationsDir(import.meta.dirname)!;
const ENGINE = repoMigrations(DIR).filter((m) => isEngineMigration(m.name));
const at = "2026-10-22T00:00:00.000Z";
const FULL_LEDGER: LedgerRow[] = ENGINE.map((m) => ({ name: m.name, checksum: m.checksum, applied_at: at }));
const SECRETS = /hunter2pw|SECRETVALUE|stagingref|prodref123|hooks\.example/;

const STAGING_FILE = [
  "# staging", "HAGGLE_ENV=staging", "HAGGLE_MODE=live", "export INKBOX_API_KEY=ik_SECRETVALUE", 'INKBOX_WEBHOOK_SECRET="whsec_SECRETVALUE"', "ANTHROPIC_API_KEY=sk-ant-SECRETVALUE # comment",
  "SUPABASE_DB_URL=postgres://u:hunter2pw@db.stagingref.supabase.co:5432/postgres", "HAGGLE_PROD_DB_HOSTS=prodref123", "HAGGLE_PAYMENTS=manual", "HAGGLE_BUILD_SHA=abc1234",
  "HAGGLE_ALERT_WEBHOOK_URL=https://hooks.example/SECRETVALUE", "HAGGLE_AI_MAX_CALLS_PER_JOB=60", "HAGGLE_AI_DAILY_TOKEN_BUDGET=3000000",
].join("\n");

function deps(over: Partial<GateDeps> & { files?: Record<string, string>; ledger?: LedgerRow[] | null } = {}): GateDeps & { reads: string[] } {
  const reads: string[] = [];
  const { files = { "staging.env": STAGING_FILE }, ledger = FULL_LEDGER, ...rest } = over;
  return {
    reads,
    readFile: (p) => { reads.push(p); if (!(p in files)) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" }); return files[p]!; },
    processEnv: {},
    migrationsDir: DIR,
    readLedger: async () => ledger,
    build: () => ({ builtAt: 2_000, newestSource: 1_000 }),
    ...rest,
  };
}
const opts = (o: Partial<GateOptions> = {}): GateOptions => ({ target: "staging", envFile: "staging.env", dbUrlEnv: "SUPABASE_DB_URL", allowAhead: false, checkWebhooks: false, skipConfig: false, skipBuild: false, json: false, ...o });
const status = (r: { checks: { name: string; status: string }[] }, name: string) => r.checks.find((c) => c.name === name)?.status;

describe("launch gate", () => {
  it("parses arguments and refuses bad ones", () => {
    expect(parseGateArgs(["--target", "staging", "--env-file", "s.env", "--db-url-env", "SUPABASE_DB_URL"])).toMatchObject({ target: "staging", envFile: "s.env", dbUrlEnv: "SUPABASE_DB_URL", checkWebhooks: false });
    expect(() => parseGateArgs([])).toThrow(/usage/);
    expect(() => parseGateArgs(["--target", "prod"])).toThrow(/usage/);
    expect(() => parseGateArgs(["--target", "staging", "--db-url-env", "postgres://x"])).toThrow(/environment variable/);
    expect(() => parseGateArgs(["--target", "staging", "--check-webhooks"])).toThrow(/--webhook-url/);
  });

  it("parses env files (export, quotes, comments) without touching process.env", () => {
    expect(parseEnvFile(STAGING_FILE)).toMatchObject({ HAGGLE_ENV: "staging", INKBOX_API_KEY: "ik_SECRETVALUE", INKBOX_WEBHOOK_SECRET: "whsec_SECRETVALUE", ANTHROPIC_API_KEY: "sk-ant-SECRETVALUE" });
    expect(process.env.INKBOX_API_KEY).not.toBe("ik_SECRETVALUE");
  });

  it("a complete staging setup passes; output names checks, never values", async () => {
    const r = await runLaunchGate(opts(), deps());
    expect(r.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["config:pass", "recommended variables:pass", "migration files:pass", "migrations:pass", "build:pass", "tests last green:skip", "webhook subscriptions:skip"]);
    expect(r.ok).toBe(true);
    expect(formatGate(r) + JSON.stringify(r)).not.toMatch(SECRETS);
  });

  it("never reads .env by default: without --env-file the config check fails closed", async () => {
    const d = deps();
    const r = await runLaunchGate(opts({ envFile: undefined }), d);
    expect(status(r, "config")).toBe("fail");
    expect(d.reads).toEqual([]);
    expect(r.ok).toBe(false);
  });

  it("each failing prerequisite fails the gate on its own", async () => {
    const cases: [string, GateOptions, GateDeps, string, RegExp][] = [
      ["env file for another target", opts({ target: "production" }), deps(), "config", /HAGGLE_ENV in the file is staging, not production/],
      ["invalid config", opts(), deps({ files: { "staging.env": STAGING_FILE.replace("HAGGLE_PAYMENTS=manual", "HAGGLE_PAYMENTS=stripe") } }), "config", /HAGGLE_PAYMENTS must be one of manual/],
      ["mock mode for staging", opts(), deps({ files: { "staging.env": STAGING_FILE.replace("HAGGLE_MODE=live", "HAGGLE_MODE=mock") } }), "config", /HAGGLE_MODE must be live for staging/],
      ["missing env file", opts({ envFile: "nope.env" }), deps(), "config", /cannot read the env file \(ENOENT\)/],
      ["no ledger", opts(), deps({ ledger: null }), "migrations", /ledger absent/],
      ["pending migration", opts(), deps({ ledger: FULL_LEDGER.slice(1) }), "migrations", new RegExp(`pending: ${ENGINE[0]!.name}`)],
      ["drift", opts(), deps({ ledger: FULL_LEDGER.map((r, i) => (i === 0 ? { ...r, checksum: "0".repeat(64) } : r)) }), "migrations", /DRIFT/],
      ["database ahead", opts(), deps({ ledger: [...FULL_LEDGER, { name: "199_engine_future.sql", checksum: "a".repeat(64), applied_at: at }] }), "migrations", /UNEXPECTED.*199_engine_future\.sql/],
      ["ledger unreadable", opts(), deps({ readLedger: async () => { throw Object.assign(new Error("connect ECONNREFUSED postgres://u:hunter2pw@db.stagingref.supabase.co"), { code: "ECONNREFUSED" }); } }), "migrations", /ledger unreadable \(ECONNREFUSED\)/],
      ["db url not set", opts({ dbUrlEnv: "OTHER_DB_URL" }), deps(), "migrations", /OTHER_DB_URL is not set/],
      ["production database from staging", opts(), deps({ files: { "staging.env": STAGING_FILE.replace("db.stagingref.supabase.co", "db.prodref123.supabase.co") } }), "config", /points at a production database/],
      ["no build", opts(), deps({ build: () => null }), "build", /missing/],
      ["stale build", opts(), deps({ build: () => ({ builtAt: 1, newestSource: 2 }) }), "build", /older than the sources/],
      ["no migrations folder", opts(), deps({ migrationsDir: null }), "migration files", /not found/],
    ];
    for (const [name, o, d, check, msg] of cases) {
      const r = await runLaunchGate(o, d);
      const c = r.checks.find((x) => x.name === check);
      expect(c?.status, name).toBe("fail");
      expect(c?.detail, name).toMatch(msg);
      expect(r.ok, name).toBe(false);
      expect(formatGate(r) + JSON.stringify(r), name).not.toMatch(SECRETS);
    }
  });

  it("the ledger read refuses a production database for a non-production target, before connecting", async () => {
    let connected = false;
    const d = deps({ readLedger: async () => { connected = true; return FULL_LEDGER; }, processEnv: { PROD_URL: "postgres://postgres.prodref123:hunter2pw@aws-0.pooler.supabase.com:5432/postgres", HAGGLE_PROD_DB_HOSTS: "prodref123" } });
    const r = await runLaunchGate(opts({ dbUrlEnv: "PROD_URL", skipConfig: true }), d);
    expect(status(r, "migrations")).toBe("fail");
    expect(connected).toBe(false);
    // The same URL is fine for --target production (that is its database).
    const p = await runLaunchGate(opts({ target: "production", dbUrlEnv: "PROD_URL", skipConfig: true }), d);
    expect(status(p, "migrations")).toBe("pass");
  });

  it("warnings and skips don't fail it: --allow-ahead, recommended variables, missing optional webhook events", async () => {
    const ahead = await runLaunchGate(opts({ allowAhead: true }), deps({ ledger: [...FULL_LEDGER, { name: "199_engine_future.sql", checksum: "a".repeat(64), applied_at: at }] }));
    expect(status(ahead, "migrations")).toBe("pass");
    const thin = await runLaunchGate(opts(), deps({ files: { "staging.env": STAGING_FILE.split("\n").filter((l) => !/BUILD_SHA|ALERT_WEBHOOK/.test(l)).join("\n") } }));
    expect(thin.checks.find((c) => c.name === "recommended variables")).toMatchObject({ status: "warn", detail: "not set: HAGGLE_BUILD_SHA, HAGGLE_ALERT_WEBHOOK_URL" });
    expect(thin.ok).toBe(true);
  });

  it("webhook subscriptions: read-only, opt-in, needs the key from the env file; message.received is required", async () => {
    const url = "https://staging.example/webhooks/inkbox";
    let calls = 0;
    const list = (subs: { url: string; eventTypes: string[] }[]) => async () => { calls++; return subs; };
    const w = (subs: { url: string; eventTypes: string[] }[]) => runLaunchGate(opts({ checkWebhooks: true, webhookUrl: url }), deps({ listWebhooks: list(subs) }));
    expect((await w([{ url, eventTypes: ["message.received", "call.ended", "imessage.received", "a2a.sent_task.updated"] }])).checks.find((c) => c.name === "webhook subscriptions")).toMatchObject({ status: "pass" });
    expect((await w([{ url, eventTypes: ["message.received"] }])).checks.find((c) => c.name === "webhook subscriptions")).toMatchObject({ status: "warn", detail: expect.stringMatching(/call\.ended/) });
    expect((await w([{ url, eventTypes: ["call.ended"] }])).ok).toBe(false);
    expect((await w([{ url: "https://old.example/webhooks/inkbox", eventTypes: ["message.received"] }])).ok).toBe(false);
    const before = calls;
    await runLaunchGate(opts(), deps({ listWebhooks: list([]) }));
    expect(calls).toBe(before); // off by default
    const noKey = await runLaunchGate(opts({ checkWebhooks: true, webhookUrl: url, envFile: "k.env" }), deps({ files: { "k.env": "HAGGLE_ENV=staging\nHAGGLE_MODE=live" }, listWebhooks: list([]) }));
    expect(noKey.checks.find((c) => c.name === "webhook subscriptions")).toMatchObject({ status: "fail", detail: "INKBOX_API_KEY is not in the env file" });
  });
});
