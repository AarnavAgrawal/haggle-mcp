// Deployment environment and configuration checks. HAGGLE_ENV (development | staging | production)
// says where a server runs; HAGGLE_MODE (mock | live) says whether it talks to real providers.
// The checks run before the runtime is built and fail closed: a server with a problem serves only
// the MCP handshake, /health (503) and /ready (503), and tools return CONFIG_MISSING. Messages name
// the variable and what is wrong with it, never its value.
//   production   live mode only; every mock-only / rehearsal flag refused.
//   development, staging   refuse a production database (HAGGLE_PROD_DB_HOSTS, or a "production"
//                marker in the URL) unless the operator sets HAGGLE_ALLOW_PROD_DB=true.

export type HaggleEnv = "development" | "staging" | "production";
type Env = Record<string, string | undefined>;

export const HAGGLE_ENVS: readonly HaggleEnv[] = ["development", "staging", "production"];
export const LIVE_REQUIRED = ["INKBOX_API_KEY", "INKBOX_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "SUPABASE_DB_URL"] as const;
/** Rehearsal flags that change behaviour in ways production must never have. */
export const MOCK_ONLY_FLAGS = [
  "HAGGLE_SIM_DELAY_SCALE", "HAGGLE_MOCK_VENDORS", "HAGGLE_MOCK_PERSONAS_FILE", "HAGGLE_PLACES_FIXTURE", "HAGGLE_MOCK_DATABASE_URL",
  "HAGGLE_MOCK_BRAIN_FILE", "HAGGLE_MOCK_WORKSPACES", "HAGGLE_APPROVALS",
] as const;
/** Boolean flags production refuses when "true" (demo shortcuts, contacting anyone). */
export const PRODUCTION_FORBIDDEN_TRUE = ["HAGGLE_DEMO_SPEED", "HAGGLE_ALLOW_ANY_RECIPIENT", "SELLERS_ALLOW_UNSIGNED"] as const;
/** URLs that may point at a database (checked against the production-database guard). */
export const DB_URL_VARS = ["SUPABASE_DB_URL", "HAGGLE_MOCK_DATABASE_URL", "HAGGLE_TEST_DATABASE_URL"] as const;

export interface ConfigReport {
  env: HaggleEnv;
  mode: "mock" | "live";
  /** Problems that stop the server (each names a variable). */
  errors: string[];
  /** Worth logging, not fatal. */
  warnings: string[];
}

export class ConfigError extends Error {
  override name = "ConfigError";
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`configuration refused: ${errors.join("; ")}`);
    this.errors = errors;
  }
}

const set = (v: string | undefined) => v !== undefined && v.trim() !== "";
const truthy = (v: string | undefined) => v?.trim().toLowerCase() === "true";

/** The deployment environment; unset = development. An unknown value is reported by checkConfig. */
export function haggleEnv(env: Env = process.env): HaggleEnv {
  const v = env.HAGGLE_ENV?.trim().toLowerCase();
  return (HAGGLE_ENVS as readonly string[]).includes(v ?? "") ? (v as HaggleEnv) : "development";
}

/** Hosts / Supabase project refs of production databases (HAGGLE_PROD_DB_HOSTS, comma-separated). */
export function prodDbHosts(env: Env = process.env): string[] {
  return (env.HAGGLE_PROD_DB_HOSTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * Does this connection string point at a production database? Matches a listed host (or a
 * subdomain of it), a listed Supabase project ref in the host (db.<ref>.supabase.co) or in the
 * pooler user name (postgres.<ref>), or a "production"/"prod" marker in host, database or user.
 */
export function looksLikeProductionDb(url: string, hosts: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const user = decodeURIComponent(u.username).toLowerCase();
  const db = decodeURIComponent(u.pathname.replace(/^\//, "")).toLowerCase();
  for (const h of hosts) {
    if (host === h || host.endsWith(`.${h}`) || host.split(".").includes(h)) return true;
    if (user.split(".").slice(1).includes(h)) return true;
  }
  const tokens = [host, user, db].flatMap((s) => s.split(/[^a-z0-9]+/));
  return tokens.some((t) => t === "production" || t === "prod");
}

/** Errors that stop a script or server from touching a production database outside production. */
export function prodDbGuard(env: Env = process.env, vars: readonly string[] = DB_URL_VARS): string[] {
  const e = haggleEnv(env);
  if (e === "production" || truthy(env.HAGGLE_ALLOW_PROD_DB)) return [];
  const hosts = prodDbHosts(env);
  return vars.filter((k) => set(env[k]) && looksLikeProductionDb(env[k]!, hosts))
    .map((k) => `${k} points at a production database but HAGGLE_ENV is ${e} (use a development database, set HAGGLE_ENV=production on the production server, or set HAGGLE_ALLOW_PROD_DB=true for a deliberate operator task)`);
}

const isPostgresUrl = (v: string) => {
  try {
    const u = new URL(v);
    return (u.protocol === "postgres:" || u.protocol === "postgresql:") && !!u.hostname;
  } catch {
    return false;
  }
};
const positiveInt = (v: string | undefined) => v === undefined || v.trim() === "" || (/^\d+$/.test(v.trim()) && Number(v) > 0);

/** Every configuration problem, without building anything or calling any provider. */
export function checkConfig(env: Env = process.env): ConfigReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawEnv = env.HAGGLE_ENV?.trim();
  if (set(rawEnv) && !(HAGGLE_ENVS as readonly string[]).includes(rawEnv!.toLowerCase())) errors.push(`HAGGLE_ENV must be one of ${HAGGLE_ENVS.join(", ")}`);
  const he = haggleEnv(env);
  const rawMode = env.HAGGLE_MODE?.trim();
  if (set(rawMode) && rawMode !== "mock" && rawMode !== "live") errors.push("HAGGLE_MODE must be mock or live");
  const mode = rawMode === "live" ? "live" : "mock";

  if (he === "production") {
    if (mode !== "live") errors.push("HAGGLE_MODE must be live when HAGGLE_ENV=production");
    for (const k of MOCK_ONLY_FLAGS) if (set(env[k])) errors.push(`${k} is a mock/rehearsal flag and is refused when HAGGLE_ENV=production`);
    for (const k of PRODUCTION_FORBIDDEN_TRUE) if (truthy(env[k])) errors.push(`${k}=true is refused when HAGGLE_ENV=production`);
    if (set(env.HAGGLE_ENABLE_PAYMENTS) && truthy(env.HAGGLE_ENABLE_PAYMENTS) && env.HAGGLE_PAYMENTS?.trim() !== "manual") warnings.push("HAGGLE_ENABLE_PAYMENTS uses Stripe test mode; production pilots should use HAGGLE_PAYMENTS=manual");
  } else if (mode === "live" && !set(rawEnv)) {
    warnings.push("HAGGLE_ENV is not set (treated as development); set it explicitly on every deployed server");
  }
  errors.push(...prodDbGuard(env));

  if (mode === "live") {
    for (const k of LIVE_REQUIRED) if (!set(env[k])) errors.push(`${k} is required in live mode`);
    if (set(env.SUPABASE_DB_URL) && !isPostgresUrl(env.SUPABASE_DB_URL!)) errors.push("SUPABASE_DB_URL is not a postgres:// connection string");
    if (env.HAGGLE_EXTERNAL_SENDERS === "reply_token" && (env.HAGGLE_REPLY_TOKEN_SECRET?.trim().length ?? 0) < 16) errors.push("HAGGLE_REPLY_TOKEN_SECRET must be at least 16 characters with HAGGLE_EXTERNAL_SENDERS=reply_token");
    if (truthy(env.HAGGLE_ENABLE_PAYMENTS) && env.HAGGLE_PAYMENTS?.trim() !== "manual") {
      for (const k of ["STRIPE_SECRET_KEY", "STRIPE_CUSTOMER_ID", "STRIPE_PAYMENT_METHOD_ID"]) if (!set(env[k])) errors.push(`${k} is required with HAGGLE_ENABLE_PAYMENTS=true`);
      if (set(env.STRIPE_SECRET_KEY) && !env.STRIPE_SECRET_KEY!.trim().startsWith("sk_test_")) errors.push("STRIPE_SECRET_KEY must be a test-mode key (sk_test_); live Stripe keys are refused");
    }
  } else if (set(env.HAGGLE_MOCK_DATABASE_URL) && !isPostgresUrl(env.HAGGLE_MOCK_DATABASE_URL!)) {
    errors.push("HAGGLE_MOCK_DATABASE_URL is not a postgres:// connection string");
  }
  if (set(env.HAGGLE_TICK_SECRET) && env.HAGGLE_TICK_SECRET!.trim().length < 16) errors.push("HAGGLE_TICK_SECRET must be at least 16 characters (or empty to disable /internal/tick)");
  if (set(env.HAGGLE_ALERT_WEBHOOK_URL) && !/^https:\/\//i.test(env.HAGGLE_ALERT_WEBHOOK_URL!.trim())) errors.push("HAGGLE_ALERT_WEBHOOK_URL must be an https:// URL");
  for (const k of ["HAGGLE_AI_MAX_CALLS_PER_JOB", "HAGGLE_AI_DAILY_TOKEN_BUDGET", "HAGGLE_STALL_CHECK_EVERY_S"]) if (!positiveInt(env[k]) && !(k === "HAGGLE_STALL_CHECK_EVERY_S" && env[k]?.trim() === "0")) errors.push(`${k} must be a positive integer`);
  if (set(env.HAGGLE_DB_POOL_MAX) && !(/^\d+$/.test(env.HAGGLE_DB_POOL_MAX!.trim()) && Number(env.HAGGLE_DB_POOL_MAX) >= 1 && Number(env.HAGGLE_DB_POOL_MAX) <= 10)) errors.push("HAGGLE_DB_POOL_MAX must be an integer from 1 to 10");
  if (he === "production" && mode === "live" && !set(env.HAGGLE_AI_DAILY_TOKEN_BUDGET)) warnings.push("HAGGLE_AI_DAILY_TOKEN_BUDGET is not set: Claude usage is metered but not capped per day");
  return { env: he, mode, errors, warnings };
}

/** checkConfig, throwing ConfigError on any error (the runtime calls this before building anything). */
export function assertConfig(env: Env = process.env): ConfigReport {
  const r = checkConfig(env);
  if (r.errors.length) throw new ConfigError(r.errors);
  return r;
}

/**
 * For operator scripts that open SUPABASE_DB_URL directly (workspace-admin, workspace-create,
 * migrations, job-ops): exits before connecting when the URL is a production database and
 * HAGGLE_ENV isn't production (override: HAGGLE_ALLOW_PROD_DB=true). Call it first in main().
 */
export function guardScriptDatabase(script: string, env: Env = process.env): void {
  const errors = prodDbGuard(env, ["SUPABASE_DB_URL"]);
  if (!errors.length) return;
  console.error(`${script} refused: ${errors.join("; ")}`);
  process.exit(2);
}
