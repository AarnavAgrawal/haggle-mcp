/**
 * Pre-kickoff infrastructure preflight. READ-ONLY: no email is sent, no migration is applied,
 * no money moves, nothing is deployed. Secret values are never printed (only presence/length,
 * and equality checks by hash).
 *
 *   corepack pnpm --filter @haggle/spikes preflight            # all checks
 *   corepack pnpm --filter @haggle/spikes preflight primitive  # one of: env primitive anthropic supabase wallet stripe
 *
 * No billable calls: Anthropic is checked through the Models API only (no generation).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

type Status = "PASS" | "BLOCKED" | "FAILED" | "NOT VERIFIED" | "ACTION REQUIRED" | "INFO";
const results: { area: string; check: string; status: Status; detail: string }[] = [];
const record = (area: string, check: string, status: Status, detail = "") => {
  results.push({ area, check, status, detail });
  console.log(`[${status}] ${area} · ${check}${detail ? ` — ${detail}` : ""}`);
};

const env = (k: string) => process.env[k]?.trim() || "";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SECRETISH = /(key|secret|token|password|signature|private)/i;

// Shrinks an API response to something safe and short to print.
function redact(v: unknown, depth = 0): unknown {
  if (depth > 3) return "…";
  if (Array.isArray(v)) return v.length > 5 ? [...v.slice(0, 5).map((x) => redact(x, depth + 1)), `…+${v.length - 5}`] : v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, SECRETISH.test(k) && typeof x === "string" ? `<redacted len=${x.length}>` : redact(x, depth + 1)]),
    );
  }
  return typeof v === "string" && v.length > 120 ? `${v.slice(0, 117)}…` : v;
}

// ---------------------------------------------------------------- env
function checkEnv() {
  const required = [
    "PRIMITIVE_API_KEY", "PRIMITIVE_WEBHOOK_SECRET", "HAGGLE_INBOX_DOMAIN",
    "ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL",
  ];
  const later = ["PRIMITIVE_WEBHOOK_ENDPOINT_ID", "HAGGLE_PAYER_PRIVATE_KEY"];
  for (const k of required) record("env", k, env(k) ? "PASS" : "ACTION REQUIRED", env(k) ? `set (len ${env(k).length})` : "missing");
  for (const k of later) record("env", k, env(k) ? "PASS" : "INFO", env(k) ? "set" : "not set (needed later: webhook endpoint at deploy, payer key for x402)");
  record("env", "HAGGLE_MODE", "INFO", env("HAGGLE_MODE") || "unset");
  if (env("PRIMITIVE_API_KEY") && !env("PRIMITIVE_API_KEY").startsWith("prim_")) record("env", "PRIMITIVE_API_KEY format", "ACTION REQUIRED", "expected prim_ prefix");
  if (env("ANTHROPIC_API_KEY") && !env("ANTHROPIC_API_KEY").startsWith("sk-ant-")) record("env", "ANTHROPIC_API_KEY format", "ACTION REQUIRED", "expected sk-ant- prefix");
  const inbox = env("HAGGLE_BUYER_INBOX");
  if (inbox && env("HAGGLE_INBOX_DOMAIN") && !inbox.toLowerCase().endsWith(`@${env("HAGGLE_INBOX_DOMAIN").toLowerCase()}`))
    record("env", "HAGGLE_BUYER_INBOX domain", "ACTION REQUIRED", "inbox is not on HAGGLE_INBOX_DOMAIN");
  const sk = env("SUPABASE_SERVICE_ROLE_KEY");
  if (sk) record("env", "SUPABASE_SERVICE_ROLE_KEY format", sk.startsWith("sb_secret_") || sk.startsWith("eyJ") ? "PASS" : "ACTION REQUIRED",
    sk.startsWith("sb_secret_") ? "modern secret key (sb_secret_)" : sk.startsWith("eyJ") ? "legacy service_role JWT" : "expected sb_secret_… or legacy JWT");
  const pk = env("HAGGLE_PAYER_PRIVATE_KEY");
  if (pk && !/^0x[0-9a-fA-F]{64}$/.test(pk)) record("env", "HAGGLE_PAYER_PRIVATE_KEY format", "ACTION REQUIRED", "expected 0x + 64 hex");
}

// ---------------------------------------------------------------- primitive
const PRIM = "https://api.primitive.dev/v1";
async function prim(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${PRIM}${path}`, { headers: { authorization: `Bearer ${env("PRIMITIVE_API_KEY")}` }, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const data = (b: any) => (b && typeof b === "object" && "data" in b ? b.data : b);

async function checkPrimitive() {
  if (!env("PRIMITIVE_API_KEY")) return record("primitive", "all", "ACTION REQUIRED", "PRIMITIVE_API_KEY missing");
  const show = async (check: string, path: string) => {
    try {
      const r = await prim(path);
      const ok = r.status >= 200 && r.status < 300;
      record("primitive", check, ok ? "INFO" : "BLOCKED", `GET ${path} → ${r.status} ${JSON.stringify(redact(ok ? data(r.body) : r.body))}`);
      return ok ? data(r.body) : null;
    } catch (e) {
      record("primitive", check, "BLOCKED", `GET ${path} failed: ${(e as Error).message}`);
      return null;
    }
  };

  const who = await show("whoami", "/whoami");
  record("primitive", "API key authenticates", who ? "PASS" : "BLOCKED");
  await show("account", "/account");
  const domains = await show("domains", "/domains");
  const want = env("HAGGLE_INBOX_DOMAIN").toLowerCase();
  if (want) {
    const names = JSON.stringify(domains ?? "").toLowerCase();
    record("primitive", "HAGGLE_INBOX_DOMAIN belongs to this org", names.includes(want) ? "PASS" : "ACTION REQUIRED",
      names.includes(want) ? want : `${want} not found in GET /domains`);
  }
  await show("inbox readiness", "/inbox/status");
  const outbound = await show("outbound readiness", "/outbound/status");
  const from = env("HAGGLE_BUYER_INBOX") || (want ? `buyer@${want}` : "");
  if (outbound && from) {
    const fromDomain = from.split("@")[1]?.toLowerCase() ?? "";
    const sendable: string[] = (outbound.sendable_domains ?? []).map((d: unknown) => String(typeof d === "object" && d ? (d as any).domain ?? (d as any).name : d).toLowerCase());
    record("primitive", `can send From ${from} (non-sending check)`, sendable.includes(fromDomain) ? "PASS" : "BLOCKED",
      sendable.includes(fromDomain) ? `${fromDomain} in sendable_domains` : `sendable_domains=${JSON.stringify(sendable)}`);
  }
  await show("send-permissions (reply-only restriction)", "/send-permissions");
  const endpoints = await show("webhook endpoints", "/endpoints");
  record("primitive", "webhook endpoint configured", Array.isArray(endpoints) && endpoints.length ? "PASS" : "NOT VERIFIED",
    Array.isArray(endpoints) && endpoints.length ? `${endpoints.length} endpoint(s)` : "none yet; create after the first deploy exposes POST /inbound");
  await show("recipient routes", "/routes");
  const lp = await prim("/emails?limit=1").catch(() => null);
  record("primitive", "inbound list / long-poll endpoint reachable", lp?.status === 200 ? "PASS" : "BLOCKED",
    lp?.status === 200 ? `GET /emails 200, meta.cursor=${JSON.stringify(lp.body?.meta?.cursor)}; since/wait behaviour NOT VERIFIED (no mail yet)` : `status ${lp?.status}`);
  await show("credits", "/credits/balance");
  const account = await prim("/account").catch(() => null);
  const ents: string[] = data(account?.body)?.entitlements ?? [];
  for (const e of ["send_mail", "interactions_enabled", "x402_payments", "send_to_primitive_managed_domains"])
    record("primitive", `entitlement ${e}`, ents.includes(e) ? "PASS" : "BLOCKED", ents.includes(e) ? "present" : "missing from /account entitlements");
  await show("x402 spend policy (payer entitlement)", "/x402/spend-policy");

  // Compare the configured webhook secret to the org's without printing either.
  if (env("PRIMITIVE_WEBHOOK_SECRET")) {
    try {
      const r = await prim("/account/webhook-secret");
      const d = data(r.body);
      const live = typeof d === "string" ? d : (d?.secret ?? d?.webhook_secret ?? "");
      if (r.status !== 200 || !live) record("primitive", "webhook secret matches org", "BLOCKED", `GET /account/webhook-secret → ${r.status}`);
      else record("primitive", "webhook secret matches org", sha(live) === sha(env("PRIMITIVE_WEBHOOK_SECRET")) ? "PASS" : "ACTION REQUIRED",
        sha(live) === sha(env("PRIMITIVE_WEBHOOK_SECRET")) ? "hash equal" : "configured secret differs from org secret");
    } catch (e) {
      record("primitive", "webhook secret matches org", "BLOCKED", (e as Error).message);
    }
  }
}

// ---------------------------------------------------------------- anthropic
async function checkAnthropic() {
  const key = env("ANTHROPIC_API_KEY");
  if (!key) return record("anthropic", "all", "ACTION REQUIRED", "ANTHROPIC_API_KEY missing");
  // Keys not scoped to a workspace must name one on every request.
  const headers: Record<string, string> = { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" };
  if (env("ANTHROPIC_WORKSPACE_ID")) headers["anthropic-workspace-id"] = env("ANTHROPIC_WORKSPACE_ID");
  const model = env("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  try {
    const m = await fetch(`https://api.anthropic.com/v1/models/${model}`, { headers, signal: AbortSignal.timeout(15_000) });
    const b: any = await m.json().catch(() => null);
    record("anthropic", `key can access ${model} (Models API, no generation)`, m.ok ? "PASS" : "BLOCKED",
      m.ok ? `GET /v1/models/${model} → ${m.status} id=${b?.id}` : `${m.status} ${b?.error?.type ?? ""}: ${b?.error?.message ?? ""}`);
    if (m.ok) for (const c of ["structured_outputs", "pdf_input"])
      record("anthropic", `${c} (as reported by Models API; not exercised)`, b?.capabilities?.[c]?.supported ? "PASS" : "BLOCKED", String(b?.capabilities?.[c]?.supported));
  } catch (e) {
    record("anthropic", "connectivity", "BLOCKED", (e as Error).message);
  }
}

// ---------------------------------------------------------------- supabase
// Uses psql inside a throwaway container (no local psql needed). The URL is passed by env, not argv.
const READONLY_SQL = `
set default_transaction_read_only = on;
\\pset format unaligned
\\pset tuples_only on
select 'server_version=' || current_setting('server_version');
select 'database=' || current_database() || ' user=' || current_user;
select 'role_bypassrls=' || rolbypassrls || ' superuser=' || rolsuper from pg_roles where rolname = current_user;
select 'schemas=' || string_agg(nspname, ',' order by nspname) from pg_namespace where nspname in ('public','auth','storage','supabase_migrations','extensions');
select 'public_tables=' || count(*) from pg_tables where schemaname = 'public';
select 'haggle_tables_present=' || count(*) from pg_tables where schemaname = 'public' and tablename in ('jobs','quotes','payment_attempts','audit_events');
select 'public_tables_without_rls=' || coalesce(string_agg(c.relname, ','), 'none') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
select (to_regclass('supabase_migrations.schema_migrations') is not null) as has_mig \\gset
\\if :has_mig
select 'applied_migrations=' || coalesce((select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations), 'none');
\\else
select 'applied_migrations=none (no supabase_migrations table)';
\\endif
select 'extensions=' || string_agg(extname || ' ' || extversion, ',' order by extname) from pg_extension;
`;

function checkSupabase() {
  const url = env("SUPABASE_DB_URL");
  if (!url) return record("supabase", "all", "ACTION REQUIRED", "SUPABASE_DB_URL missing");
  const ref = env("SUPABASE_URL").match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
  let dbHost = "", dbUser = "";
  // psql splits userinfo at the FIRST '@', so a raw '@' in the password moves part of it into the host.
  const userinfo = url.match(/^[a-z]+:\/\/(.*)@[^@]*$/i)?.[1] ?? "";
  if ((userinfo.match(/@/g) ?? []).length > 0)
    record("supabase", "SUPABASE_DB_URL password is URL-encoded", "ACTION REQUIRED", "password contains a raw '@'; write it as %40");
  try { const u = new URL(url); dbHost = u.hostname; dbUser = decodeURIComponent(u.username); } catch { return record("supabase", "SUPABASE_DB_URL parses", "ACTION REQUIRED", "not a valid postgres URL"); }
  if (ref) {
    const sameProject = dbHost.includes(ref) || dbUser.endsWith(`.${ref}`);
    record("supabase", "DB URL and SUPABASE_URL point at the same project", sameProject ? "PASS" : "ACTION REQUIRED",
      sameProject ? `project ref ${ref}` : `SUPABASE_URL ref ${ref} (len ${ref.length}) ≠ db user ${dbUser} @ ${dbHost}`);
  } else record("supabase", "SUPABASE_URL format", "ACTION REQUIRED", "expected https://<ref>.supabase.co");

  const r = spawnSync("docker", ["run", "--rm", "-i", "-e", "PGURL", "-e", "PGCONNECT_TIMEOUT=15", "postgres:17-alpine", "sh", "-c", 'psql "$PGURL" -v ON_ERROR_STOP=1 -X -q'], {
    input: READONLY_SQL, env: { ...process.env, PGURL: url }, encoding: "utf8", timeout: 120_000,
  });
  if (r.status !== 0) {
    // Scrub the URL, its userinfo, and every userinfo fragment so no part of the password is echoed.
    let err = r.stderr || r.error?.message || "";
    for (const piece of [url, userinfo, ...userinfo.split(/[:@]/)].filter((p) => p.length >= 3).sort((a, b) => b.length - a.length))
      err = err.split(piece).join("<redacted>");
    err = err.split("\n").filter(Boolean).slice(-3).join(" | ");
    return record("supabase", "connect (read-only session)", "BLOCKED", err);
  }
  record("supabase", "connect (read-only session)", "PASS");
  const facts = Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)));
  for (const [k, v] of Object.entries(facts)) record("supabase", k, "INFO", String(v));
  record("supabase", "connecting role can see force-RLS tables", facts.role_bypassrls?.startsWith("true") ? "PASS" : "ACTION REQUIRED",
    facts.role_bypassrls?.startsWith("true") ? "BYPASSRLS" : "role lacks BYPASSRLS; the server would read nothing from the Haggle tables");
  record("supabase", "Haggle migration not yet applied (expected pre-kickoff)", facts.haggle_tables_present === "0" ? "PASS" : "INFO",
    `${facts.haggle_tables_present ?? "?"} of 4 sentinel tables present`);
}

// ---------------------------------------------------------------- wallet (read-only RPC)
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"; // Circle test USDC on Base Sepolia
async function rpc(method: string, params: unknown[]) {
  const r = await fetch(BASE_SEPOLIA_RPC, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b: any = await r.json();
  if (b.error) throw new Error(b.error.message);
  return b.result as string;
}
async function checkWallet() {
  const pk = env("HAGGLE_PAYER_PRIVATE_KEY");
  if (!pk) return record("wallet", "payer key", "NOT VERIFIED", "HAGGLE_PAYER_PRIVATE_KEY not set");
  // viem ships with the Primitive SDK; resolve it from there rather than adding a dependency.
  const req = createRequire(createRequire(import.meta.url).resolve("@primitivedotdev/sdk"));
  const { privateKeyToAccount } = req("viem/accounts") as { privateKeyToAccount: (k: `0x${string}`) => { address: string } };
  const address = privateKeyToAccount(pk as `0x${string}`).address;
  record("wallet", "payer address derived locally (no signing)", "PASS", address);
  try {
    const chain = parseInt(await rpc("eth_chainId", []), 16);
    record("wallet", "RPC is Base Sepolia", chain === 84532 ? "PASS" : "FAILED", `chainId ${chain}`);
    const eth = BigInt(await rpc("eth_getBalance", [address, "latest"]));
    record("wallet", "ETH balance (gas not needed for EIP-3009 payer)", "PASS", `${eth} wei`);
    const usdc = BigInt(await rpc("eth_call", [{ to: BASE_SEPOLIA_USDC, data: `0x70a08231${address.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"]));
    record("wallet", "test USDC ≥ 5 (5_000_000 base units)", usdc >= 5_000_000n ? "PASS" : "BLOCKED", `${usdc} base units`);
  } catch (e) {
    record("wallet", "Base Sepolia RPC", "NOT VERIFIED", (e as Error).message);
  }
}

// ---------------------------------------------------------------- stripe (presence only; no API objects created)
async function checkStripe() {
  const k = env("STRIPE_SECRET_KEY");
  if (!k) return record("stripe", "STRIPE_SECRET_KEY", "NOT VERIFIED", "not configured (2 PM fallback)");
  if (!k.startsWith("sk_test_") && !k.startsWith("rk_test_")) return record("stripe", "test-mode key", "FAILED", "key is not a test-mode key; refusing to call");
  const r = await fetch("https://api.stripe.com/v1/balance", { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15_000) });
  record("stripe", "test-mode key authenticates (GET /v1/balance)", r.ok ? "PASS" : "BLOCKED", `${r.status}`);
}

// ---------------------------------------------------------------- main
const only = process.argv[2];
const run = async (name: string, fn: () => unknown) => { if (!only || only === name) await fn(); };
await run("env", checkEnv);
await run("primitive", checkPrimitive);
await run("anthropic", checkAnthropic);
await run("supabase", checkSupabase);
await run("wallet", checkWallet);
await run("stripe", checkStripe);

const counts = results.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
console.log(`\nsummary: ${JSON.stringify(counts)}`);
process.exit(results.some((r) => r.status === "BLOCKED" || r.status === "FAILED") ? 1 : 0);
