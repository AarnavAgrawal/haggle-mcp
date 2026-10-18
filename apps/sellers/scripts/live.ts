/**
 * Live setup for a hosted Haggle server (Manufact) that deals with this org's seller fleet.
 * Secrets stay in the gitignored .haggle-data folder and are never printed.
 *
 *   npm run live -w @haggle/sellers -- env               # 1. buyer signing key + .haggle-data/manufact.env
 *   npx mcp-use deploy ... --env-file .haggle-data/manufact.env
 *   npm run live -w @haggle/sellers -- webhook <MCP URL> # 2. buyer mail + call.ended → <server>/webhooks/inkbox
 *   npm run live -w @haggle/sellers -- check             # what's configured, no changes
 *
 * Reads the repo-root .env: INKBOX_API_KEY (org key, setup only; never deployed),
 * HAGGLE_BUYER_API_KEY (the buyer identity's own key, deployed), BUYER_HANDLE (default haggle-buyer),
 * HAGGLE_BUYER_SIGNING_KEY (when the buyer is shared with another server: its current whsec_ key),
 * MISSION_EATS_PHONE, ANTHROPIC_API_KEY, SUPABASE_DB_URL (+ optional SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
// Setup-only: the same read-only Stripe test-mode check the engine ships (no charge).
import { verifyStripeTestSetup } from "../../../packages/engine/src/payments/stripe.ts";
import { PERSONAS } from "../src/personas.ts";
import { DATA_DIR, loadRegistry } from "../src/store.ts";

const LIVE_FILE = join(DATA_DIR, "live.json");
const ENV_FILE = join(DATA_DIR, "manufact.env");
const BUYER_EVENTS = ["message.received", "call.ended"];

const env = process.env;
const buyerHandle = env.BUYER_HANDLE ?? "haggle-buyer";
const admin = new Inkbox(); // INKBOX_API_KEY: the org that owns the buyer and the sellers

type LiveState = { buyerSigningKey?: string; webhookUrl?: string };
const loadLive = (): LiveState => (existsSync(LIVE_FILE) ? (JSON.parse(readFileSync(LIVE_FILE, "utf8")) as LiveState) : {});
const saveLive = (s: LiveState) => writeFileSync(LIVE_FILE, JSON.stringify(s, null, 2));

function need(name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

function e164(raw: string | undefined): string | undefined {
  const n = raw?.replace(/[^\d+]/g, "");
  if (!n) return undefined;
  if (!/^\+\d{10,15}$/.test(n)) throw new Error(`MISSION_EATS_PHONE must be E.164, e.g. +16505550123`);
  return n;
}

/** The fleet as the hosted server needs it: emails for outreach, the phone business, real addresses. */
function fleetConfig() {
  const registry = loadRegistry();
  const missing = PERSONAS.filter((p) => p.channel !== "phone" && !registry[p.handle]?.email).map((p) => p.handle);
  if (missing.length) throw new Error(`No mailbox recorded for ${missing.join(", ")}: run \`npm run setup -w @haggle/sellers\` first`);
  const phone = e164(env.MISSION_EATS_PHONE);
  const emailers = PERSONAS.filter((p) => p.channel !== "phone");
  const fleet = emailers.map((p) => `${p.name} <${registry[p.handle]!.email}>`).join("; ");
  const directory = PERSONAS.map((p) => ({
    id: p.business_id,
    ...(p.channel !== "phone" ? { email: registry[p.handle]!.email } : {}),
    ...(p.channel === "phone" && phone ? { phone } : {}),
    ...(registry[p.handle]?.cardUrl ? { a2a_card_url: registry[p.handle]!.cardUrl } : {}),
  }));
  return { fleet, directory, phone };
}

async function cmdEnv() {
  const buyer = await admin.getIdentity(buyerHandle);
  if (!buyer.emailAddress) throw new Error(`${buyerHandle} has no mailbox`);
  console.log(`buyer ${buyerHandle} <${buyer.emailAddress}>, phone ${buyer.phoneNumber?.number ?? "NONE (calls will fail)"}`);

  // The deployed server uses the buyer's own key, never the org key; check it really reaches the buyer.
  const buyerKey = need("HAGGLE_BUYER_API_KEY");
  const scoped = await new Inkbox({ apiKey: buyerKey }).getIdentity(buyerHandle).catch((e: unknown) => {
    throw new Error(`HAGGLE_BUYER_API_KEY can't read ${buyerHandle}: ${(e as Error).message}`);
  });
  if (scoped.id !== buyer.id) throw new Error("HAGGLE_BUYER_API_KEY belongs to a different identity");

  // Identity-level key: it signs every webhook for the buyer, for every server subscribed to it.
  // A buyer shared with another server keeps that server's key (HAGGLE_BUYER_SIGNING_KEY); we only
  // rotate when nobody else depends on it, or with --rotate.
  const live = loadLive();
  const shared = env.HAGGLE_BUYER_SIGNING_KEY?.trim();
  if (shared) {
    if (!shared.startsWith("whsec_")) throw new Error("HAGGLE_BUYER_SIGNING_KEY should start with whsec_");
    live.buyerSigningKey = shared;
    saveLive(live);
    console.log("  using the shared buyer signing key from HAGGLE_BUYER_SIGNING_KEY");
  } else if (!live.buyerSigningKey) {
    const others = (await admin.webhooks.subscriptions.list({ agentIdentityId: buyer.id, scope: "identity" })).filter((s) => !s.url.endsWith("/webhooks/inkbox"));
    if (others.length && !process.argv.includes("--rotate")) {
      throw new Error(`${buyerHandle} also sends webhooks to ${others.map((s) => new URL(s.url).host).join(", ")}; rotating its key would break them. Set HAGGLE_BUYER_SIGNING_KEY to the current key, or pass --rotate.`);
    }
    live.buyerSigningKey = (await buyer.createSigningKey()).signingKey;
    saveLive(live);
    console.log("  buyer signing key created (stored in .haggle-data/live.json)");
  }

  // Stripe TEST mode (optional): only a verified sk_test_ key + test customer + attached test card.
  let stripe: Record<string, string> = {};
  if (env.STRIPE_SECRET_KEY?.trim()) {
    const cfg = { secretKey: env.STRIPE_SECRET_KEY.trim(), customerId: need("STRIPE_CUSTOMER_ID"), paymentMethodId: need("STRIPE_PAYMENT_METHOD_ID") };
    if (!cfg.secretKey.startsWith("sk_test_")) throw new Error("STRIPE_SECRET_KEY must be a test key (sk_test_...)");
    const check = await verifyStripeTestSetup(cfg);
    for (const c of check.checks) console.log(`  stripe [${c.ok ? "PASS" : "FAIL"}] ${c.check}`);
    if (!check.ok) throw new Error("Stripe test setup failed; run node packages/engine/scripts/stripe-setup.ts .env --confirm");
    stripe = {
      HAGGLE_ENABLE_PAYMENTS: "true", STRIPE_SECRET_KEY: cfg.secretKey, STRIPE_CUSTOMER_ID: cfg.customerId, STRIPE_PAYMENT_METHOD_ID: cfg.paymentMethodId,
      // Test money, but sized for real orders: a 200-person deposit is $500–1,750. Every charge still
      // needs the human's approval of that exact quote and amount, under the deal's own cap.
      // Per-payment safety ceiling: the Stripe rail's $10,000 maximum (a no-deposit quote is paid in full).
      HAGGLE_GLOBAL_PAYMENT_CAP_CENTS: env.HAGGLE_GLOBAL_PAYMENT_CAP_CENTS ?? "1000000",
      HAGGLE_SPENDING_CAP_CEILING_CENTS: env.HAGGLE_SPENDING_CAP_CEILING_CENTS ?? "1000000",
    };
  }

  const { fleet, directory, phone } = fleetConfig();
  const supabase = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY;
  const vars: Record<string, string> = {
    HAGGLE_MODE: "live",
    INKBOX_API_KEY: buyerKey,
    INKBOX_IDENTITY: buyerHandle,
    INKBOX_SENDER_TRUST: "pinned-org-identity",
    INKBOX_WEBHOOK_SECRET: live.buyerSigningKey,
    HAGGLE_ENABLE_CALLS: phone ? "true" : "false",
    // Local hours "start-end" when calls may go out (server default 9-20); "0-24" for a demo callee who agreed.
    ...(env.HAGGLE_CALL_HOURS?.trim() ? { HAGGLE_CALL_HOURS: env.HAGGLE_CALL_HOURS.trim() } : {}),
    HAGGLE_DEMO_FLEET: fleet,
    HAGGLE_ALLOWED_RECIPIENTS: phone ?? "",
    HAGGLE_DIRECTORY_JSON: JSON.stringify(directory),
    ANTHROPIC_API_KEY: need("ANTHROPIC_API_KEY"),
    ...(env.ANTHROPIC_MODEL ? { ANTHROPIC_MODEL: env.ANTHROPIC_MODEL } : {}),
    SUPABASE_DB_URL: need("SUPABASE_DB_URL"),
    ...(env.HAGGLE_DB_SCHEMA ? { HAGGLE_DB_SCHEMA: env.HAGGLE_DB_SCHEMA } : {}),
    ...(supabase ? { SUPABASE_URL: env.SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY! } : { HAGGLE_BRAIN_STORE: "memory" }),
    ...stripe,
    HOST: "0.0.0.0",
  };
  writeFileSync(ENV_FILE, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  console.log(`wrote ${ENV_FILE} (${Object.keys(vars).length} variables; calls ${vars.HAGGLE_ENABLE_CALLS === "true" ? `ON to ${phone} only` : "off"}; payments ${vars.HAGGLE_ENABLE_PAYMENTS === "true" ? "Stripe TEST mode" : "off"})`);
}

async function cmdWebhook(mcpUrl: string | undefined) {
  if (!mcpUrl || !/^https:\/\//.test(mcpUrl)) throw new Error("Pass the deployed MCP URL (https://…/mcp) copied from Manufact");
  const url = `${new URL(mcpUrl).origin}/webhooks/inkbox`;
  const buyer = await admin.getIdentity(buyerHandle);
  const existing = await admin.webhooks.subscriptions.list({ agentIdentityId: buyer.id, scope: "identity" });
  if (existing.some((s) => s.url === url)) {
    console.log(`buyer webhooks → ${url} (already subscribed)`);
  } else {
    await admin.webhooks.subscriptions.create({ agentIdentityId: buyer.id, url, eventTypes: BUYER_EVENTS });
    console.log(`buyer webhooks → ${url} [${BUYER_EVENTS.join(", ")}]`);
  }
  saveLive({ ...loadLive(), webhookUrl: url });
  const health = await fetch(`${new URL(mcpUrl).origin}/health`).then((r) => r.json()).catch((e: unknown) => ({ error: (e as Error).message }));
  console.log("server /health:", JSON.stringify(health));
}

async function cmdCheck() {
  const buyer = await admin.getIdentity(buyerHandle);
  const subs = await admin.webhooks.subscriptions.list({ agentIdentityId: buyer.id, scope: "identity" });
  const live = loadLive();
  console.log(`buyer ${buyerHandle} <${buyer.emailAddress}> phone ${buyer.phoneNumber?.number ?? "none"}`);
  console.log(`signing key stored: ${Boolean(live.buyerSigningKey)} · env file: ${existsSync(ENV_FILE)}`);
  for (const s of subs) console.log(`  webhook → ${s.url} [${(s.eventTypes ?? []).join(", ")}]`);
  if (!subs.length) console.log("  no buyer webhooks yet (run `webhook <MCP URL>` after deploying)");
}

const [cmd, arg] = process.argv.slice(2);
const run = cmd === "env" ? cmdEnv() : cmd === "webhook" ? cmdWebhook(arg) : cmd === "check" ? cmdCheck() : Promise.reject(new Error("usage: live env | webhook <MCP URL> | check"));
run.catch((e: unknown) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
