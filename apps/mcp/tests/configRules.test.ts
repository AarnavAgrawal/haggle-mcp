// One test per startup rule (src/config.ts): each unsafe configuration is refused on its own (or
// warned, where the code has a safe fallback), with a message naming the variable and never a value,
// and the runtime refuses to build on any error.
import { describe, expect, it } from "vitest";
import { checkConfig, ConfigError } from "../src/config.ts";
import { getRuntime, resetRuntime } from "../src/runtime.ts";

const SECRETS = /hunter2pw|SECRETVALUE|prodref123/;
const LIVE = { HAGGLE_MODE: "live", HAGGLE_ENV: "staging", HAGGLE_PROD_DB_HOSTS: "prodref123", INKBOX_API_KEY: "ik_SECRETVALUE", INKBOX_WEBHOOK_SECRET: "whsec_SECRETVALUE", ANTHROPIC_API_KEY: "sk-ant-SECRETVALUE", SUPABASE_DB_URL: "postgres://u:hunter2pw@db.stagingref.supabase.co:5432/postgres" };
const PROD = { ...LIVE, HAGGLE_ENV: "production", SUPABASE_DB_URL: "postgres://postgres.prodref123:hunter2pw@aws-0.pooler.supabase.com:5432/postgres", HAGGLE_AI_DAILY_TOKEN_BUDGET: "3000000" };

const ERRORS: [string, Record<string, string>, RegExp][] = [
  ["unknown HAGGLE_ENV", { ...LIVE, HAGGLE_ENV: "prod" }, /^HAGGLE_ENV must be one of/],
  ["unknown HAGGLE_MODE", { HAGGLE_MODE: "real" }, /^HAGGLE_MODE must be mock or live$/],
  ["production in mock mode", { HAGGLE_ENV: "production" }, /^HAGGLE_MODE must be live when HAGGLE_ENV=production$/],
  ["production with a rehearsal flag", { ...PROD, HAGGLE_MOCK_VENDORS: "none" }, /^HAGGLE_MOCK_VENDORS is a mock\/rehearsal flag/],
  ["production with demo speed", { ...PROD, HAGGLE_DEMO_SPEED: "true" }, /^HAGGLE_DEMO_SPEED=true is refused/],
  ["production with unsigned sellers", { ...PROD, SELLERS_ALLOW_UNSIGNED: "true" }, /^SELLERS_ALLOW_UNSIGNED=true is refused/],
  ["staging on the production database", { ...LIVE, SUPABASE_DB_URL: PROD.SUPABASE_DB_URL }, /^SUPABASE_DB_URL points at a production database but HAGGLE_ENV is staging/],
  ["development on a 'production' URL", { ...LIVE, HAGGLE_ENV: "development", HAGGLE_PROD_DB_HOSTS: "", SUPABASE_DB_URL: "postgres://u:hunter2pw@db.example/haggle_production" }, /points at a production database/],
  ["live without a required key", { ...LIVE, INKBOX_WEBHOOK_SECRET: "" }, /^INKBOX_WEBHOOK_SECRET is required in live mode$/],
  ["live with a non-postgres URL", { ...LIVE, SUPABASE_DB_URL: "https://hunter2pw.example" }, /^SUPABASE_DB_URL is not a postgres:\/\/ connection string$/],
  ["reply tokens with a short secret", { ...LIVE, HAGGLE_EXTERNAL_SENDERS: "reply_token", HAGGLE_REPLY_TOKEN_SECRET: "SECRETVALUE" }, /^HAGGLE_REPLY_TOKEN_SECRET must be at least 16/],
  ["Stripe payments without the customer", { ...LIVE, HAGGLE_ENABLE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_test_SECRETVALUE", STRIPE_PAYMENT_METHOD_ID: "pm_x" }, /^STRIPE_CUSTOMER_ID is required/],
  ["a live Stripe key", { ...LIVE, HAGGLE_ENABLE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_live_SECRETVALUE", STRIPE_CUSTOMER_ID: "cus_x", STRIPE_PAYMENT_METHOD_ID: "pm_x" }, /^STRIPE_SECRET_KEY must be a test-mode key/],
  ["a mock database that isn't postgres", { HAGGLE_MOCK_DATABASE_URL: "mysql://u:hunter2pw@x/y" }, /^HAGGLE_MOCK_DATABASE_URL is not a postgres:\/\/ connection string$/],
  ["a short tick secret", { ...LIVE, HAGGLE_TICK_SECRET: "SECRETVALUE" }, /^HAGGLE_TICK_SECRET must be at least 16/],
  ["an http alert webhook", { ...LIVE, HAGGLE_ALERT_WEBHOOK_URL: "http://hooks.example/SECRETVALUE" }, /^HAGGLE_ALERT_WEBHOOK_URL must be an https:\/\/ URL$/],
  ["a negative stall interval", { ...LIVE, HAGGLE_STALL_CHECK_EVERY_S: "-1" }, /^HAGGLE_STALL_CHECK_EVERY_S must be a positive integer$/],
  ["an oversized pool", { ...LIVE, HAGGLE_DB_POOL_MAX: "15" }, /^HAGGLE_DB_POOL_MAX must be an integer from 1 to 10$/],
  ["a payment cap over the hard maximum", { ...LIVE, HAGGLE_GLOBAL_PAYMENT_CAP_CENTS: "5000000" }, /^HAGGLE_GLOBAL_PAYMENT_CAP_CENTS must be an integer from 1 to 1000000$/],
  ["an unknown payments mode", { ...PROD, HAGGLE_PAYMENTS: "stripe" }, /^HAGGLE_PAYMENTS must be one of manual$/],
];

describe("startup rules: each unsafe configuration on its own", () => {
  for (const [name, env, msg] of ERRORS) {
    it(`refuses ${name}`, () => {
      const r = checkConfig(env);
      expect(r.errors.some((e) => msg.test(e)), JSON.stringify(r.errors)).toBe(true);
      expect(JSON.stringify(r)).not.toMatch(SECRETS);
    });
  }

  it("the baseline staging and production configs pass (so each case above fails for its own reason)", () => {
    expect(checkConfig(LIVE).errors).toEqual([]);
    expect(checkConfig({ ...PROD, HAGGLE_PAYMENTS: "manual" })).toMatchObject({ errors: [], warnings: [] });
  });

  it("warnings: unset HAGGLE_ENV on a live server, unset daily AI budget and Stripe test mode in production", () => {
    const { HAGGLE_ENV: _e, ...noEnv } = LIVE;
    expect(checkConfig(noEnv).warnings).toContain("HAGGLE_ENV is not set (treated as development); set it explicitly on every deployed server");
    const { HAGGLE_AI_DAILY_TOKEN_BUDGET: _b, ...noBudget } = PROD;
    expect(checkConfig(noBudget).warnings).toContain("HAGGLE_AI_DAILY_TOKEN_BUDGET is not set: Claude usage is metered but not capped per day");
    expect(checkConfig({ ...PROD, HAGGLE_ENABLE_PAYMENTS: "true", STRIPE_SECRET_KEY: "sk_test_SECRETVALUE", STRIPE_CUSTOMER_ID: "cus_x", STRIPE_PAYMENT_METHOD_ID: "pm_x" }).warnings).toContain("HAGGLE_ENABLE_PAYMENTS uses Stripe test mode; production pilots should use HAGGLE_PAYMENTS=manual");
  });

  it("the runtime refuses to build on every error case (fails closed before any provider is touched)", async () => {
    for (const [name, env] of ERRORS) {
      resetRuntime();
      const err = await getRuntime(env as NodeJS.ProcessEnv).catch((e) => e);
      expect(err, name).toBeInstanceOf(ConfigError);
      expect(String(err.message), name).not.toMatch(SECRETS);
    }
    resetRuntime();
  });
});
