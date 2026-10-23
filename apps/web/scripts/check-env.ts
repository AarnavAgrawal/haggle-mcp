// Web app pre-deploy env check: every variable a public web deployment needs, with its rule.
// Prints names, rules and PASS / WARN / FAIL only, never a value. Exit 0 = nothing failed (warnings
// allowed), 1 = something failed, 2 = usage error. Runs on plain Node 22 (type stripping): no imports
// outside node:*, no TypeScript-only syntax.
//
//   node apps/web/scripts/check-env.ts [--env-file <file>] [--site live|demo] [--json]
//
// --env-file  read ONLY this file (e.g. from `vercel env pull`); without it, the current environment.
// --site      live (default): a public site on a live MCP server. demo: NEXT_PUBLIC_HAGGLE_DEMO=true
//             against a mock-mode server (cron optional).
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";

type Env = Record<string, string | undefined>;
export type Site = "live" | "demo";
export type CheckStatus = "pass" | "warn" | "fail";
export interface EnvCheck { name: string; status: CheckStatus; detail: string }
export interface EnvReport { ok: boolean; site: Site; checks: EnvCheck[] }

const val = (env: Env, k: string) => env[k]?.trim() ?? "";

/** The `role` claim of a legacy Supabase JWT key (anon / service_role); null when it isn't one. */
function jwtRole(key: string): string | null {
  const part = key.split(".")[1];
  if (!part) return null;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { role?: unknown };
    return typeof claims.role === "string" ? claims.role : null;
  } catch {
    return null;
  }
}

function parseUrl(v: string): URL | null {
  try {
    return new URL(v);
  } catch {
    return null;
  }
}

const isLocalHost = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".local");

/** Names that must never be NEXT_PUBLIC_ (inlined into the browser bundle for anyone to read). */
const SECRET_SHAPED = /SECRET|SERVICE_ROLE|TOKEN|API_KEY|PRIVATE|PASSWORD|DB_URL/;

export function checkWebEnv(env: Env, site: Site): EnvReport {
  const checks: EnvCheck[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  const live = site === "live";

  // Supabase (sign-in, memberships, chat threads).
  const sbUrl = val(env, "NEXT_PUBLIC_SUPABASE_URL");
  const u = parseUrl(sbUrl);
  if (!sbUrl) add("NEXT_PUBLIC_SUPABASE_URL", "fail", "missing: the Supabase project URL (Settings → API)");
  else if (!u) add("NEXT_PUBLIC_SUPABASE_URL", "fail", "not a URL");
  else if (u.protocol !== "https:") add("NEXT_PUBLIC_SUPABASE_URL", "fail", "must be https:// on a deployed site");
  else add("NEXT_PUBLIC_SUPABASE_URL", "pass", "https URL (inlined into the browser bundle at build time)");

  const anon = val(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const service = val(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!anon) add("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fail", "missing: the anon (publishable) key");
  else if (jwtRole(anon) === "service_role" || anon.startsWith("sb_secret_")) add("NEXT_PUBLIC_SUPABASE_ANON_KEY", "fail", "is a SERVICE-ROLE / secret key: it would ship to every browser. Use the anon (publishable) key and rotate the exposed one");
  else add("NEXT_PUBLIC_SUPABASE_ANON_KEY", "pass", "set, not a service-role key");

  if (!service) add("SUPABASE_SERVICE_ROLE_KEY", "fail", "missing: the service-role (secret) key, server only");
  else if (service === anon || jwtRole(service) === "anon" || service.startsWith("sb_publishable_")) add("SUPABASE_SERVICE_ROLE_KEY", "fail", "is the anon (publishable) key, not the service-role key");
  else add("SUPABASE_SERVICE_ROLE_KEY", "pass", "set, server only");

  // The Haggle MCP server.
  const mcp = val(env, "HAGGLE_MCP_URL");
  const m = parseUrl(mcp);
  if (!mcp) add("HAGGLE_MCP_URL", "fail", "missing: the MCP server's base URL (copy it from the Manufact dashboard, without /mcp)");
  else if (!m) add("HAGGLE_MCP_URL", "fail", "not a URL");
  else if (m.protocol !== "https:") add("HAGGLE_MCP_URL", "fail", "must be https:// (the service token travels on every call)");
  else if (isLocalHost(m.hostname)) add("HAGGLE_MCP_URL", "fail", "points at this machine; a deployed site needs the hosted server");
  else if (/\/mcp\/?$/.test(m.pathname)) add("HAGGLE_MCP_URL", "fail", "ends in /mcp: give the base URL, the app adds /mcp and /internal/* itself");
  else add("HAGGLE_MCP_URL", "pass", "https base URL");

  const token = val(env, "HAGGLE_SERVICE_TOKEN");
  if (!token) add("HAGGLE_SERVICE_TOKEN", "fail", "missing: the shared secret with the MCP server (same value on both, at least 32 characters)");
  else if (token.length < 32) add("HAGGLE_SERVICE_TOKEN", "fail", "shorter than 32 characters (the server refuses it)");
  else add("HAGGLE_SERVICE_TOKEN", "pass", "at least 32 characters (must equal the server's)");

  // The chat.
  const anthropic = val(env, "ANTHROPIC_API_KEY");
  if (!anthropic) add("ANTHROPIC_API_KEY", "fail", "missing: the chat can't run without it");
  else if (!anthropic.startsWith("sk-ant-")) add("ANTHROPIC_API_KEY", "warn", "doesn't look like an Anthropic key (sk-ant-…)");
  else add("ANTHROPIC_API_KEY", "pass", "set");

  const demo = val(env, "NEXT_PUBLIC_HAGGLE_DEMO");
  if (live && demo === "true") add("NEXT_PUBLIC_HAGGLE_DEMO", "fail", "is true on a live site: guests, demo banner and simulated examples would ship. Unset it (or use --site demo)");
  else if (!live && demo !== "true") add("NEXT_PUBLIC_HAGGLE_DEMO", "fail", "must be true on a demo site");
  else add("NEXT_PUBLIC_HAGGLE_DEMO", "pass", live ? "not true (live site)" : "true (demo site)");

  // The background-tick backup (app/api/cron/tick).
  const cron = val(env, "CRON_SECRET");
  const tick = val(env, "HAGGLE_TICK_SECRET");
  if (!cron) add("CRON_SECRET", live ? "fail" : "pass", live ? "missing: the cron backup of the server's tick (/api/cron/tick) stays off; at least 16 characters" : "not set: cron backup off (fine for a demo)");
  else if (cron.length < 16) add("CRON_SECRET", "fail", "shorter than 16 characters");
  else if (cron === token) add("CRON_SECRET", "fail", "equals HAGGLE_SERVICE_TOKEN: never reuse the service token (it opens every workspace)");
  else add("CRON_SECRET", "pass", "at least 16 characters");

  if (!tick) add("HAGGLE_TICK_SECRET", cron ? "fail" : "pass", cron ? "missing: /api/cron/tick needs it (the same value as on the MCP server, at least 16 characters)" : "not set (cron backup off)");
  else if (tick.length < 16) add("HAGGLE_TICK_SECRET", "fail", "shorter than 16 characters (the server refuses it)");
  else if (tick === token) add("HAGGLE_TICK_SECRET", "fail", "equals HAGGLE_SERVICE_TOKEN: never reuse the service token");
  else if (tick === cron) add("HAGGLE_TICK_SECRET", "warn", "equals CRON_SECRET: use two different secrets");
  else add("HAGGLE_TICK_SECRET", "pass", "at least 16 characters (must equal the server's)");

  // Abuse and cost controls, contact.
  if (!val(env, "NEXT_PUBLIC_TURNSTILE_SITE_KEY")) add("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "warn", "not set: sign-in has no captcha (set it and enable Turnstile in Supabase Auth → Attack Protection)");
  else add("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "pass", "set (Supabase must have the matching Turnstile secret)");

  const cap = val(env, "WEB_CHAT_DAILY_CAP");
  if (!cap) add("WEB_CHAT_DAILY_CAP", "warn", "not set: no site-wide daily cap on chat turns (Claude spend)");
  else if (!/^\d+$/.test(cap)) add("WEB_CHAT_DAILY_CAP", "fail", "must be a whole number (0 = no cap)");
  else add("WEB_CHAT_DAILY_CAP", cap === "0" ? "warn" : "pass", cap === "0" ? "0: no daily cap" : "a whole number");

  const support = val(env, "NEXT_PUBLIC_SUPPORT_EMAIL");
  if (!support) add("NEXT_PUBLIC_SUPPORT_EMAIL", "warn", "not set: the footer and legal pages have no contact address");
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support)) add("NEXT_PUBLIC_SUPPORT_EMAIL", "fail", "not an email address");
  else add("NEXT_PUBLIC_SUPPORT_EMAIL", "pass", "an email address");

  const output = val(env, "NEXT_OUTPUT");
  if (output && output !== "standalone") add("NEXT_OUTPUT", "fail", "only standalone is supported (the container image)");

  for (const k of Object.keys(env).sort()) {
    if (k.startsWith("NEXT_PUBLIC_") && SECRET_SHAPED.test(k.slice(12)) && val(env, k)) add(k, "fail", "a secret-shaped NEXT_PUBLIC_ variable is inlined into the browser bundle: remove it");
  }
  return { ok: !checks.some((c) => c.status === "fail"), site, checks };
}

export function formatReport(r: EnvReport): string {
  const width = Math.max(...r.checks.map((c) => c.name.length));
  const lines = r.checks.map((c) => `${c.status.toUpperCase().padEnd(4)}  ${c.name.padEnd(width)}  ${c.detail}`);
  const n = (s: CheckStatus) => r.checks.filter((c) => c.status === s).length;
  lines.push("", `web env (${r.site} site): ${n("fail")} failed, ${n("warn")} warnings, ${n("pass")} passed${r.ok ? "" : ". Fix every FAIL before deploying."}`);
  return lines.join("\n");
}

function main(argv: string[]): number {
  let envFile: string | undefined;
  let site: Site = "live";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env-file") envFile = argv[++i];
    else if (a === "--site") {
      const s = argv[++i];
      if (s !== "live" && s !== "demo") return usage(`--site must be live or demo`);
      site = s;
    } else if (a === "--json") json = true;
    else return usage(`unknown argument ${a}`);
  }
  let env: Env = process.env;
  if (envFile !== undefined) {
    if (!envFile) return usage("--env-file needs a path");
    try {
      env = parseEnv(readFileSync(envFile, "utf8"));
    } catch {
      return usage("couldn't read the --env-file");
    }
  }
  const r = checkWebEnv(env, site);
  console.log(json ? JSON.stringify(r, null, 2) : formatReport(r));
  return r.ok ? 0 : 1;
}

function usage(problem: string): number {
  console.error(`check-env: ${problem}\nusage: node apps/web/scripts/check-env.ts [--env-file <file>] [--site live|demo] [--json]`);
  return 2;
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/check-env.ts")) process.exit(main(process.argv.slice(2)));
