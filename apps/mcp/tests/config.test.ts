// Deployment configuration (src/config.ts): HAGGLE_ENV separation, fail-closed live checks, the
// production-database guard for development servers and operator scripts. Messages name the
// variable, never its value.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertConfig, checkConfig, ConfigError, haggleEnv, looksLikeProductionDb, MOCK_ONLY_FLAGS, prodDbGuard } from "../src/config.ts";
import { getRuntime, resetRuntime } from "../src/runtime.ts";

const SECRET = "sk-ant-api03-VERYSECRETVALUE123";
const PROD_DB = "postgres://postgres.prodref123:hunter2pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const LIVE = { HAGGLE_MODE: "live", INKBOX_API_KEY: "ik_live_SECRETVALUE", INKBOX_WEBHOOK_SECRET: "whsec_SECRETVALUE1", ANTHROPIC_API_KEY: SECRET, SUPABASE_DB_URL: "postgres://u:pw@db.devref.supabase.co:5432/postgres" };
const leaks = (r: { errors: string[]; warnings: string[] }) => JSON.stringify(r).match(/hunter2pw|VERYSECRET|SECRETVALUE|prodref123/);

describe("HAGGLE_ENV", () => {
  it("defaults to development; unknown values are an error", () => {
    expect(haggleEnv({})).toBe("development");
    expect(haggleEnv({ HAGGLE_ENV: "Production" })).toBe("production");
    expect(checkConfig({ HAGGLE_ENV: "prod" }).errors).toEqual(["HAGGLE_ENV must be one of development, staging, production"]);
    expect(checkConfig({ HAGGLE_MODE: "demo" }).errors).toEqual(["HAGGLE_MODE must be mock or live"]);
  });

  it("a plain mock development server needs nothing", () => {
    expect(checkConfig({})).toMatchObject({ env: "development", mode: "mock", errors: [] });
  });
});

describe("live mode fails closed, naming the variable", () => {
  it("lists each missing required variable", () => {
    const r = checkConfig({ HAGGLE_MODE: "live", HAGGLE_ENV: "staging" });
    expect(r.errors).toEqual(["INKBOX_API_KEY is required in live mode", "INKBOX_WEBHOOK_SECRET is required in live mode", "ANTHROPIC_API_KEY is required in live mode", "SUPABASE_DB_URL is required in live mode"]);
    expect(() => assertConfig({ HAGGLE_MODE: "live" })).toThrow(ConfigError);
  });

  it("validates formats without echoing values", () => {
    const r = checkConfig({ ...LIVE, HAGGLE_ENV: "staging", SUPABASE_DB_URL: "mysql://hunter2pw@x", HAGGLE_EXTERNAL_SENDERS: "reply_token", HAGGLE_REPLY_TOKEN_SECRET: "short", HAGGLE_TICK_SECRET: "tiny", HAGGLE_ALERT_WEBHOOK_URL: "http://hooks.example/SECRETVALUE", HAGGLE_AI_MAX_CALLS_PER_JOB: "-3", HAGGLE_AI_DAILY_TOKEN_BUDGET: "1e9", HAGGLE_DB_POOL_MAX: "50", HAGGLE_ENABLE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_live_SECRETVALUE" });
    expect(r.errors).toEqual([
      "SUPABASE_DB_URL is not a postgres:// connection string",
      "HAGGLE_REPLY_TOKEN_SECRET must be at least 16 characters with HAGGLE_EXTERNAL_SENDERS=reply_token",
      "STRIPE_CUSTOMER_ID is required with HAGGLE_ENABLE_PAYMENTS=true",
      "STRIPE_PAYMENT_METHOD_ID is required with HAGGLE_ENABLE_PAYMENTS=true",
      "STRIPE_SECRET_KEY must be a test-mode key (sk_test_); live Stripe keys are refused",
      "HAGGLE_TICK_SECRET must be at least 16 characters (or empty to disable /internal/tick)",
      "HAGGLE_ALERT_WEBHOOK_URL must be an https:// URL",
      "HAGGLE_AI_MAX_CALLS_PER_JOB must be a positive integer",
      "HAGGLE_AI_DAILY_TOKEN_BUDGET must be a positive integer",
      "HAGGLE_DB_POOL_MAX must be an integer from 1 to 10",
    ]);
    expect(leaks(r)).toBeNull();
  });

  it("a complete live staging config passes; an unset HAGGLE_ENV on a live server is a warning", () => {
    expect(checkConfig({ ...LIVE, HAGGLE_ENV: "staging" }).errors).toEqual([]);
    expect(checkConfig(LIVE).warnings).toContain("HAGGLE_ENV is not set (treated as development); set it explicitly on every deployed server");
  });
});

describe("production refuses mock-only flags", () => {
  it("requires live mode and refuses every rehearsal flag and demo shortcut", () => {
    const env: Record<string, string> = { ...LIVE, HAGGLE_ENV: "production", HAGGLE_DEMO_SPEED: "true", HAGGLE_ALLOW_ANY_RECIPIENT: "true", SUPABASE_DB_URL: PROD_DB };
    for (const k of MOCK_ONLY_FLAGS) env[k] = k === "HAGGLE_MOCK_DATABASE_URL" ? "postgres://x:y@localhost/z" : "1";
    const r = checkConfig(env);
    for (const k of MOCK_ONLY_FLAGS) expect(r.errors).toContain(`${k} is a mock/rehearsal flag and is refused when HAGGLE_ENV=production`);
    expect(r.errors).toContain("HAGGLE_DEMO_SPEED=true is refused when HAGGLE_ENV=production");
    expect(r.errors).toContain("HAGGLE_ALLOW_ANY_RECIPIENT=true is refused when HAGGLE_ENV=production");
    expect(checkConfig({ HAGGLE_ENV: "production" }).errors).toContain("HAGGLE_MODE must be live when HAGGLE_ENV=production");
    expect(leaks(r)).toBeNull();
  });

  it("a clean production config passes (the production database is expected there)", () => {
    const r = checkConfig({ ...LIVE, HAGGLE_ENV: "production", SUPABASE_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123", HAGGLE_AI_DAILY_TOKEN_BUDGET: "3000000" });
    expect(r).toMatchObject({ env: "production", mode: "live", errors: [], warnings: [] });
  });
});

describe("development and staging refuse production database credentials", () => {
  it("matches listed hosts, Supabase project refs (direct host or pooler user) and a production marker", () => {
    expect(looksLikeProductionDb(PROD_DB, ["prodref123"])).toBe(true); // pooler: ref in the user name
    expect(looksLikeProductionDb("postgres://postgres:pw@db.prodref123.supabase.co:5432/postgres", ["prodref123"])).toBe(true);
    expect(looksLikeProductionDb("postgres://u:pw@pg.internal.acme.com/haggle", ["internal.acme.com"])).toBe(true);
    expect(looksLikeProductionDb("postgres://u:pw@db.devref.supabase.co/postgres", ["prodref123"])).toBe(false);
    expect(looksLikeProductionDb("postgres://u:pw@haggle-production.example.com/app", [])).toBe(true);
    expect(looksLikeProductionDb("postgres://u:pw@localhost:5432/haggle_prod", [])).toBe(true);
    expect(looksLikeProductionDb("postgres://u:pw@localhost:5432/products", [])).toBe(false);
    expect(looksLikeProductionDb("not a url", ["x"])).toBe(false);
  });

  it("refuses SUPABASE_DB_URL or a mock database pointing at production, with an explicit operator override", () => {
    for (const he of ["development", "staging"]) {
      const r = checkConfig({ ...LIVE, HAGGLE_ENV: he, SUPABASE_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123" });
      expect(r.errors).toEqual([`SUPABASE_DB_URL points at a production database but HAGGLE_ENV is ${he} (use a development database, set HAGGLE_ENV=production on the production server, or set HAGGLE_ALLOW_PROD_DB=true for a deliberate operator task)`]);
      expect(leaks(r)).toBeNull();
    }
    expect(checkConfig({ HAGGLE_MOCK_DATABASE_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123" }).errors[0]).toMatch(/^HAGGLE_MOCK_DATABASE_URL points at a production database/);
    expect(prodDbGuard({ SUPABASE_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123", HAGGLE_ALLOW_PROD_DB: "true" })).toEqual([]);
  });

  it("the runtime refuses to build (mock included) and names the problem, never the value", async () => {
    resetRuntime();
    const err = await getRuntime({ HAGGLE_MOCK_DATABASE_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123" } as NodeJS.ProcessEnv).catch((e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect(String(err.message)).toMatch(/HAGGLE_MOCK_DATABASE_URL points at a production database/);
    expect(String(err.message)).not.toMatch(/hunter2pw|prodref123/);
    resetRuntime();
  });
});

describe("operator scripts are guarded", () => {
  // tsx, as docs/deployment.md runs them (the engine uses TypeScript syntax plain `node` can't strip).
  const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
  const run = (script: string, env: Record<string, string>) => spawnSync(TSX, [join(import.meta.dirname, "..", "scripts", script), "list-vendors", "--id", "ws_acme"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 30_000 });

  it("workspace-admin exits 2 before connecting to a production database outside production", () => {
    const r = run("workspace-admin.ts", { SUPABASE_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/workspace-admin\.ts refused: SUPABASE_DB_URL points at a production database/);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2pw/);
  }, 60_000);

  it("workspace-create is guarded the same way", () => {
    const r = run("workspace-create.ts", { SUPABASE_DB_URL: "postgres://u:pw@db.example/haggle_production" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/workspace-create\.ts refused/);
  }, 60_000);
});
