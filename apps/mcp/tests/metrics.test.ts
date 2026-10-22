// Sprint 5 (E): the metrics script. Argument validation (pure), loading under plain node, the
// production-database guard, and (with HAGGLE_TEST_DATABASE_URL) a real read-only run printing real
// and simulated numbers side by side.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planMetrics } from "../scripts/metrics.ts";

const APP = join(import.meta.dirname, "..");
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

describe("metrics script", () => {
  it("validates its arguments", () => {
    expect(planMetrics([])).toEqual({ json: false, minQuotes: 3 });
    expect(planMetrics(["--json", "--since", "2026-11-01", "--until", "2026-12-01", "--workspace", "ws_acme", "--min-quotes", "2"])).toEqual({
      json: true, minQuotes: 2, since: new Date("2026-11-01T00:00:00Z"), until: new Date("2026-12-01T00:00:00Z"), workspace: "ws_acme",
    });
    expect(() => planMetrics(["--since", "Nov 1"])).toThrow(/--since must be YYYY-MM-DD/);
    expect(() => planMetrics(["--since", "2026-12-01", "--until", "2026-11-01"])).toThrow(/--until must be after --since/);
    expect(() => planMetrics(["--workspace", "acme"])).toThrow(/workspace id/);
    expect(() => planMetrics(["--min-quotes", "0"])).toThrow(/1-10/);
    expect(() => planMetrics(["--delete"])).toThrow(/unknown option --delete/);
    expect(() => planMetrics(["report"])).toThrow(/unexpected argument report/);
    expect(planMetrics(["--prices", '{"claude-sonnet-5-5":{"input":1,"output":5}}']).prices).toContain("claude-sonnet-5-5");
    expect(() => planMetrics(["--prices", '{"x":{"input":"cheap"}}'])).toThrow(/numeric input and output/);
  });

  it("loads under plain node and fails on its own when no database is configured", () => {
    const r = spawnSync(process.execPath, ["scripts/metrics.ts"], { cwd: APP, env, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
    expect(r.stderr).toMatch(/metrics failed: SUPABASE_DB_URL is not set/);
  }, 60_000);

  it("refuses a production database outside HAGGLE_ENV=production, without printing it", () => {
    const r = spawnSync(process.execPath, ["scripts/metrics.ts"], { cwd: APP, env: { ...env, SUPABASE_DB_URL: "postgres://postgres.prodref123:hunter2pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres", HAGGLE_PROD_DB_HOSTS: "prodref123", HAGGLE_ENV: "staging" }, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/metrics\.ts refused/);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2pw/);
  }, 60_000);

  const DB = process.env.HAGGLE_TEST_DATABASE_URL;
  it.skipIf(!DB)("reads a real database in one read-only transaction and prints both buckets", () => {
    const run = (args: string[]) => spawnSync(process.execPath, ["scripts/metrics.ts", ...args], { cwd: APP, env: { ...env, SUPABASE_DB_URL: DB!, HAGGLE_ENV: "development" }, encoding: "utf8", timeout: 60_000 });
    const text = run([]);
    expect(text.stderr).toBe("");
    expect(text.stdout).toMatch(/REAL\s+SIMULATED/);
    expect(text.stdout).toMatch(/Rule: real = live mode AND/);
    const json = JSON.parse(run(["--json", "--since", "2026-01-01"]).stdout);
    expect(json).toMatchObject({ window: { since: "2026-01-01" }, real: { jobs: expect.any(Number) }, simulated: { jobs: expect.any(Number) } });
  }, 60_000);
});
