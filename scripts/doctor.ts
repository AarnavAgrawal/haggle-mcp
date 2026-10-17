// Preflight: is every outside service set up the way the server needs?
// Run: npm run doctor   (reads .env; add --remote to also probe the deployed server)
//
// Prints only pass/fail and what to fix. Never prints a key, secret, or the
// approver's address. Each check is independent, so one failure doesn't hide
// the rest.
import { existsSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import primitive from "@primitivedotdev/sdk";
import { getAccount, getSendPermissions, listEndpoints } from "@primitivedotdev/sdk/api";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { ConfigError, getConfig } from "../src/config.ts";
import { parseDemoVendors } from "../src/vendors/demoVendors.ts";

type Level = "ok" | "warn" | "fail";
const ICON: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗" };
let failures = 0;
let warnings = 0;

function report(level: Level, label: string, fix?: string): void {
  if (level === "fail") failures++;
  if (level === "warn") warnings++;
  console.log(`  ${ICON[level]} ${label}${fix ? `\n      → ${fix}` : ""}`);
}

async function section(title: string, run: () => Promise<void>): Promise<void> {
  console.log(`\n${title}`);
  try {
    await run();
  } catch (err) {
    report("fail", `check crashed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

const set = (name: string) => Boolean(process.env[name]?.trim());
const domainOf = (addr: string) => addr.split("@")[1]?.toLowerCase() ?? "";
const publicMode = process.env.AUTH_MODE === "oauth";
console.log(`Mode: ${publicMode ? "public (AUTH_MODE=oauth, Supabase sign-in)" : "token (one operator, MCP_AUTH_TOKEN)"}`);

// ---------- 1. Environment ----------

await section("Environment (.env)", async () => {
  if (!existsSync(new URL("../.env", import.meta.url))) {
    report("fail", ".env not found", "cp .env.example .env, then fill it in");
    return;
  }
  try {
    getConfig();
    report("ok", "required server variables present and well-formed");
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    report("fail", `missing or malformed: ${err.missing.join(", ")}`, "see .env.example and README Setup");
  }
  const optional: [string, string][] = [
    ["STRIPE_SECRET_KEY", "needed for pay (sk_test_...)"],
    ["STRIPE_CUSTOMER_ID", "run npm run setup:stripe"],
    ["STRIPE_PAYMENT_METHOD_ID", "run npm run setup:stripe"],
    ["BUYER_EMAIL", "needed for request_approval"],
    ["MCP_AUTH_TOKEN", "without it the MCP endpoint is open to anyone with the URL"],
    ["INTERNAL_TICK_SECRET", "needed only for the optional /internal/tick cron"],
    ["LIVE_PAGE_TOKEN", "needed only for the read-only /live demo page"],
  ];
  if (publicMode) {
    if (!set("SUPABASE_PUBLISHABLE_KEY")) report("fail", "SUPABASE_PUBLISHABLE_KEY not set", "Supabase > Project Settings > API Keys > publishable (anon) key");
    const demo = parseDemoVendors(process.env.DEMO_VENDORS);
    if (demo.length === 0) report("fail", "DEMO_VENDORS not set (public users may only contact the demo restaurants)", 'e.g. DEMO_VENDORS="Budget Bites <catering@...>; Taqueria Sol <catering@...>"');
    else report("ok", `${demo.length} demo restaurants listed in DEMO_VENDORS`);
    if (process.env.SIM_ON_SERVER !== "true") report("warn", "SIM_ON_SERVER is not true", "set it on the server so the restaurants reply without your laptop (then don't run npm run sim)");
  }
  // Public mode: sign-in replaces MCP_AUTH_TOKEN, each user is their own approver,
  // and each user gets their own Stripe test customer.
  const notInPublicMode = new Set(["MCP_AUTH_TOKEN", "BUYER_EMAIL", "STRIPE_CUSTOMER_ID", "STRIPE_PAYMENT_METHOD_ID"]);
  const toCheck = publicMode ? optional.filter(([n]) => !notInPublicMode.has(n)) : optional;
  for (const [name, why] of toCheck) if (!set(name)) report("warn", `${name} not set`, why);
  if (process.env.DEMO_MODE !== "true") report("warn", "DEMO_MODE is not true", "set DEMO_MODE=true for 60 s collection windows during the demo");
  if (set("BUYER_EMAIL") && process.env.BUYER_EMAIL!.toLowerCase() === process.env.PRIMITIVE_FROM_ADDRESS?.toLowerCase()) {
    report("fail", "BUYER_EMAIL equals PRIMITIVE_FROM_ADDRESS", "the approver must be a separate inbox you can reply from");
  }
});

// ---------- 2. Supabase ----------

const TABLES = ["jobs", "vendors", "messages", "quotes", "approvals", "payments", "job_events", "webhook_events", "app_users", "sim_state"];

await section("Supabase", async () => {
  if (!set("SUPABASE_URL") || !set("SUPABASE_SERVICE_ROLE_KEY")) {
    report("fail", "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
    return;
  }
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const missing: string[] = [];
  for (const table of TABLES) {
    const { error } = await db.from(table).select("*", { count: "exact", head: true });
    if (!error) continue;
    if (error.code === "42P01" || error.code === "PGRST205" || /does not exist|schema cache/i.test(error.message)) {
      missing.push(table);
    } else {
      report("fail", `${table}: ${error.message}`, "check SUPABASE_URL and that the key is the service-role key");
      return;
    }
  }
  if (missing.length) report("fail", `tables missing: ${missing.join(", ")}`, "run src/db/schema.sql in the Supabase SQL editor");
  else report("ok", `all ${TABLES.length} tables reachable`);

  // Columns added beyond DESIGN.md §6; an older schema run would lack them.
  if (!missing.includes("messages")) {
    const { error } = await db.from("messages").select("kind, round, rfc_message_id, attachments_download_url").limit(1);
    if (error) report("fail", "messages table is missing newer columns", "re-run src/db/schema.sql (it is idempotent)");
  }
  if (!missing.includes("jobs")) {
    const { error } = await db.from("jobs").select("owner_id").limit(1);
    if (error) report("fail", "jobs table has no owner_id column", "re-run src/db/schema.sql (it is idempotent)");
  }

  if (!publicMode) return;
  // Public mode: Supabase must act as the OAuth server MCP clients sign in through.
  const base = process.env.SUPABASE_URL!.replace(/\/$/, "");
  const discovery = await fetch(`${base}/.well-known/oauth-authorization-server/auth/v1`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const meta = discovery?.ok ? ((await discovery.json()) as { registration_endpoint?: string }) : null;
  if (!meta) {
    report("fail", "Supabase OAuth server is not enabled", "Authentication > OAuth Server: enable it, set Authorization Path to /oauth/consent");
  } else if (!meta.registration_endpoint) {
    report("fail", "Supabase dynamic client registration is off", "Authentication > OAuth Server: allow dynamic client registration (MCP clients register themselves)");
  } else {
    report("ok", "Supabase OAuth server enabled with dynamic client registration");
  }
  // mcp-use's Supabase adapter verifies ES256 tokens against the project's JWKS
  // (or HS256 with MCP_USE_OAUTH_SUPABASE_JWT_SECRET). A legacy-only project fails sign-in.
  const jwks = await fetch(`${base}/auth/v1/.well-known/jwks.json`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const keys = jwks?.ok ? (((await jwks.json()) as { keys?: { alg?: string }[] }).keys ?? []) : [];
  if (keys.some((k) => k.alg === "ES256")) report("ok", "project signs tokens with ES256 (asymmetric keys)");
  else if (set("MCP_USE_OAUTH_SUPABASE_JWT_SECRET")) report("ok", "using the legacy HS256 JWT secret for token checks");
  else report("fail", "no ES256 signing key on the Supabase project", "Project Settings > JWT Keys: migrate to asymmetric (ECC P-256) keys");

  if (set("SUPABASE_PUBLISHABLE_KEY") && (process.env.LOGIN_METHODS ?? "github,email").includes("github")) {
    const res = await fetch(`${base}/auth/v1/settings`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY! }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    const settings = res?.ok ? ((await res.json()) as { external?: Record<string, boolean> }) : null;
    if (!settings) report("warn", "could not read Supabase auth settings", "check SUPABASE_PUBLISHABLE_KEY");
    else if (!settings.external?.github) report("fail", "GitHub sign-in is not enabled in Supabase", "Authentication > Sign In / Providers > GitHub (or set LOGIN_METHODS=email)");
    else report("ok", "GitHub sign-in enabled");
  }
});

// ---------- 3. Primitive ----------

await section("Primitive (broker inbox)", async () => {
  if (!set("PRIMITIVE_API_KEY")) {
    report("fail", "PRIMITIVE_API_KEY not set");
    return;
  }
  const { client } = primitive.client({ apiKey: process.env.PRIMITIVE_API_KEY! });

  const account = await getAccount({ client });
  if (!account.data?.data) {
    report("fail", `could not read the account (HTTP ${account.response?.status ?? "?"})`, "check PRIMITIVE_API_KEY");
    return;
  }
  report("ok", `account reachable (plan: ${account.data.data.plan})`);

  // Who can we send to? Outreach goes to vendors; the approval email goes to BUYER_EMAIL.
  const rules = (await getSendPermissions({ client })).data?.data ?? [];
  const canSendTo = (addr: string): boolean => {
    const domain = domainOf(addr);
    return rules.some((r) => {
      if (r.type === "any_recipient") return true;
      if (r.type === "managed_zone") return domain === r.zone || domain.endsWith(`.${r.zone}`);
      if (r.type === "your_domain") return domain === r.domain.toLowerCase();
      if (r.type === "address") return r.address.toLowerCase() === addr.toLowerCase();
      return false;
    });
  };

  if (rules.some((r) => r.type === "any_recipient")) report("ok", "can send to any recipient (not reply-only)");
  else report("warn", "account can only send to some recipients (reply-only plan?)", "fine for simulated vendors on Primitive's managed zone");

  const simFile = new URL("../sim/.addresses.json", import.meta.url);
  const sims: Record<string, string> = existsSync(simFile) ? JSON.parse(readFileSync(simFile, "utf8")) : {};
  const simAddrs = Object.values(sims);
  if (simAddrs.length === 0) {
    report("warn", "no simulator inboxes yet", "run npm run setup:sim");
  } else {
    const blocked = simAddrs.filter((a) => !canSendTo(a));
    if (blocked.length) report("fail", `cannot send to ${blocked.length} of ${simAddrs.length} simulator inboxes`, "upgrade the broker account so it is not reply-only");
    else report("ok", `can send to all ${simAddrs.length} simulator inboxes`);
  }

  // Demo vendors must be reachable too, and should be the simulator inboxes.
  const demo = parseDemoVendors(process.env.DEMO_VENDORS);
  const unreachable = demo.filter((v) => !canSendTo(v.email));
  if (unreachable.length) report("fail", `cannot send to demo vendor(s): ${unreachable.map((v) => v.name).join(", ")}`);
  const strangers = demo.filter((v) => !simAddrs.includes(v.email));
  if (demo.length && strangers.length) report("warn", `DEMO_VENDORS has addresses that aren't simulator inboxes: ${strangers.map((v) => v.name).join(", ")}`, "use the addresses from sim/.addresses.json");

  if (publicMode) {
    if (!rules.some((r) => r.type === "any_recipient")) {
      report("warn", "approval emails reach a user only after they email the broker once", "the sign-in page tells users this; ask Primitive to enable send_to_any_domain to remove the step");
    }
  } else if (set("BUYER_EMAIL")) {
    if (canSendTo(process.env.BUYER_EMAIL!)) report("ok", "can send the approval email to BUYER_EMAIL");
    else {
      report(
        "fail",
        "cannot send to BUYER_EMAIL yet",
        "send one email from BUYER_EMAIL to PRIMITIVE_FROM_ADDRESS (makes it a known address), or upgrade the account",
      );
    }
  }

  // Webhook endpoint: exists, enabled, points at our server, gets the right events.
  const endpoints = (await listEndpoints({ client })).data?.data ?? [];
  const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  const wanted = base ? `${base}/webhooks/primitive` : null;
  const ep = endpoints.find((e) => e.id === process.env.PRIMITIVE_ENDPOINT_ID) ?? endpoints.find((e) => e.url === wanted);
  if (!ep) {
    report("fail", "no webhook endpoint for this server", `create one pointing at ${wanted ?? "<PUBLIC_BASE_URL>/webhooks/primitive"}`);
    return;
  }
  let endpointOk = true;
  const problem = (label: string, fix?: string) => {
    endpointOk = false;
    report("fail", label, fix);
  };
  // The endpoint id is an identifier, not a secret, so it's safe to print.
  if (!set("PRIMITIVE_ENDPOINT_ID")) report("warn", "PRIMITIVE_ENDPOINT_ID not set", `set PRIMITIVE_ENDPOINT_ID=${ep.id} in .env and in Manufact`);
  else if (ep.id !== process.env.PRIMITIVE_ENDPOINT_ID) problem("PRIMITIVE_ENDPOINT_ID doesn't match the endpoint for this URL");
  if (wanted && ep.url !== wanted) problem("webhook endpoint URL doesn't match PUBLIC_BASE_URL", `point it at ${wanted}`);
  if (!ep.enabled || ep.deactivated_at) problem("webhook endpoint is disabled", "re-enable it in the Primitive dashboard");
  const types = ep.rules.event_types;
  if (types && types.length > 0) {
    const missingTypes = ["email.received", "email.bounced"].filter((t) => !types.includes(t));
    if (missingTypes.length) problem(`endpoint not subscribed to ${missingTypes.join(", ")}`);
  }
  if (ep.consecutive_fails > 0) report("warn", `${ep.consecutive_fails} consecutive delivery failures`, "check the deployed server's env vars and logs");
  if (endpointOk) report("ok", "webhook endpoint enabled and pointing at this server");
});

// ---------- 4. Anthropic ----------

await section("Anthropic", async () => {
  if (!set("ANTHROPIC_API_KEY")) {
    report("fail", "ANTHROPIC_API_KEY not set");
    return;
  }
  const anthropic = new Anthropic();
  for (const model of [process.env.PARSER_MODEL || "claude-haiku-5-5", process.env.WRITER_MODEL || "claude-sonnet-5-5"]) {
    try {
      await anthropic.models.retrieve(model);
      report("ok", `model available: ${model}`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      report("fail", `model ${model} not available (HTTP ${status ?? "?"})`, status === 401 ? "check ANTHROPIC_API_KEY" : "check the model id");
    }
  }
});

// ---------- 5. Stripe ----------

await section("Stripe (test mode)", async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    report("warn", "STRIPE_SECRET_KEY not set; pay will be unavailable");
    return;
  }
  if (!key.startsWith("sk_test_")) {
    report("fail", "STRIPE_SECRET_KEY is not a test-mode key", "use sk_test_...; the server refuses to boot with a live key");
    return;
  }
  const stripe = new Stripe(key);
  if (publicMode) {
    // Each user gets their own test customer on first payment; just prove the key works.
    await stripe.customers.list({ limit: 1 });
    report("ok", "test key works (per-user test customers are created on first payment)");
    return;
  }
  if (!set("STRIPE_CUSTOMER_ID") || !set("STRIPE_PAYMENT_METHOD_ID")) {
    report("fail", "customer or payment method missing", "run npm run setup:stripe");
    return;
  }
  const customer = await stripe.customers.retrieve(process.env.STRIPE_CUSTOMER_ID!);
  if (customer.deleted) report("fail", "STRIPE_CUSTOMER_ID points at a deleted customer", "run npm run setup:stripe");
  else report("ok", "test customer exists");
  const pm = await stripe.paymentMethods.retrieve(process.env.STRIPE_PAYMENT_METHOD_ID!);
  const owner = typeof pm.customer === "string" ? pm.customer : pm.customer?.id;
  if (owner !== process.env.STRIPE_CUSTOMER_ID) report("fail", "payment method is not attached to the customer", "run npm run setup:stripe");
  else report("ok", "payment method attached to the customer");
});

// ---------- 6. Deployed server (optional) ----------

if (process.argv.includes("--remote")) {
  await section("Deployed server", async () => {
    const base = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (!base) {
      report("fail", "PUBLIC_BASE_URL not set");
      return;
    }
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) });
    report(health.ok ? "ok" : "fail", `GET /health → ${health.status}`);

    // An unsigned POST: 401 means the server has its Primitive config; 503 means it doesn't.
    const hook = await fetch(`${base}/webhooks/primitive`, { method: "POST", body: "{}", signal: AbortSignal.timeout(10_000) });
    if (hook.status === 401) report("ok", "webhook route configured (rejects unsigned requests)");
    else if (hook.status === 503) report("fail", "webhook route reports 'not configured'", "set the env vars in Manufact and redeploy");
    else report("warn", `webhook route returned ${hook.status}`);

    // (Manufact answers /health itself, so the server's mode is read from the
    // /mcp challenge below instead.)

    // Without credentials, /mcp must refuse: a bearer-token 401, or in public mode
    // an OAuth 401 that points clients at the sign-in metadata.
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      signal: AbortSignal.timeout(10_000),
    });
    const challenge = mcp.headers.get("www-authenticate") ?? "";
    if (mcp.status !== 401) report("warn", `MCP endpoint answered without credentials (${mcp.status})`, publicMode ? "set AUTH_MODE=oauth in Manufact and redeploy" : "set MCP_AUTH_TOKEN in Manufact and redeploy");
    else if (publicMode && !challenge.includes("resource_metadata")) report("fail", "MCP endpoint doesn't advertise OAuth sign-in", "check AUTH_MODE=oauth and SUPABASE_URL in Manufact");
    else report("ok", publicMode ? "MCP endpoint requires sign-in (OAuth)" : "MCP endpoint requires the bearer token");

    if (publicMode) {
      const consent = await fetch(`${base}/oauth/consent?authorization_id=doctor`, { signal: AbortSignal.timeout(10_000) });
      if (consent.ok) report("ok", "sign-in page is up at /oauth/consent");
      else report("fail", `sign-in page returned ${consent.status}`, "set SUPABASE_PUBLISHABLE_KEY in Manufact and redeploy");
    }
  });
}

console.log(`\n${failures === 0 ? "Ready" : "Not ready"}: ${failures} failure(s), ${warnings} warning(s).`);
if (!process.argv.includes("--remote")) console.log("Add --remote to also check the deployed server.");
process.exitCode = failures === 0 ? 0 : 1;
