// Live READ-ONLY acceptance checks against a deployed Haggle MCP server and its providers.
// Never contacts a business, never charges, never changes provider settings. Prints no secrets.
//   node scripts/acceptance/live-readonly.mjs <base url> [known job_id] [path to .env]
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
const [base, knownJob, envPath] = process.argv.slice(2);
const env = {};
if (envPath) for (const l of readFileSync(envPath, "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim(); }
const rows = [];
const check = (name, pass, detail = "") => { rows.push({ name, pass }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
let id = 0;
async function rpc(method, params) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  const t = await r.text(); const l = t.split("\n").find((x) => x.startsWith("data: ")); return JSON.parse(l ? l.slice(6) : t);
}
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const err = (r) => (r?.isError ? JSON.parse(r.content[0].text) : null);

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-acceptance", version: "1" } });
check("MCP initialize", init.result?.serverInfo?.name === "haggle", `version ${init.result?.serverInfo?.version}`);
const tools = (await rpc("tools/list", {})).result.tools;
const names = new Set(tools.map((t) => t.name));
const want = ["ask", "discover", "check_price", "deal", "wait_for_update", "get_quotes", "answer_business", "approve", "pay", "business_profile", "open_haggle", "settings.read", "settings.update", "mention_businesses", "approve_in_view", "list_deals", "call_back", "call_back_in_view"];
check("all v5 tools listed", want.every((n) => names.has(n)), want.filter((n) => !names.has(n)).join(", ") || `${tools.length} tools`);
const by = Object.fromEntries(tools.map((t) => [t.name, t]));
check("get_quotes bound to the deal board with an outputSchema", JSON.stringify(by.get_quotes?._meta ?? {}).includes("deal-board") && !!by.get_quotes?.outputSchema);
check("launcher has global + thread entrypoints", JSON.stringify(by.open_haggle?._meta ?? {}).includes("global") && JSON.stringify(by.open_haggle?._meta ?? {}).includes("thread"));
check("approve_in_view hidden from the model", by.approve_in_view?._meta?.ui?.visibility?.[0] === "app");
for (const [tool, args] of [["open_haggle", {}], ["settings.read", {}], ["ask", { what: "lunch catering", quantity: 25, date: "2026-10-30", area: "San Francisco, CA" }], ["discover", { category: "catering", area: "San Francisco, CA", count: 3 }], ["business_profile", { business: "Mission Eats" }], ["check_price", { what: "lunch catering", quantity: 40, area: "San Francisco, CA", total_usd: 995 }]]) {
  const r = await call(tool, args);
  check(`read-only ${tool}`, r && !r.isError, r?.isError ? err(r)?.error?.code : (r?.content?.[0]?.text ?? "").slice(0, 70));
}
if (knownJob) {
  const b = await call("get_quotes", { job_id: knownJob });
  check("get_quotes on a known live job", !b.isError && b.structuredContent?.job?.id === knownJob, `${b.structuredContent?.quotes?.length ?? 0} quotes, state ${b.structuredContent?.job?.state}`);
  const q = b.structuredContent?.quotes?.[0]?.quote_id;
  if (q) {
    check("pay without a human approval is refused", err(await call("pay", { job_id: knownJob, quote_id: q }))?.error?.code === "no_approval");
    check("headless approve can't self-approve (no human channel)", ["NO_HUMAN_CHANNEL", "not_approvable"].includes(err(await call("approve", { job_id: knownJob, quote_id: q }))?.error?.code));
  }
}
// Continuity and board state for agents without ids (read-only).
const deals = await call("list_deals", { limit: 5 });
check("list_deals finds recent deals without ids", !deals.isError && Array.isArray(deals.structuredContent?.deals), `${deals.structuredContent?.deals?.length ?? 0} deals`);
const guess = await call("get_quotes", {});
check("get_quotes() without a job_id never guesses a deal (lists recent ones instead)", guess.isError && err(guess)?.error?.code === "job_id_required" && !guess.structuredContent?.job, err(guess)?.error?.code);
const latest = await call("get_quotes", { job_id: deals.structuredContent?.deals?.[0]?.job_id });
check("board carries vendor stages and the payment state", !!latest.structuredContent?.stages && typeof latest.structuredContent?.payments_enabled === "boolean", `payments_enabled=${latest.structuredContent?.payments_enabled}`);
const roster = await call("discover", {});
check("discover reports the demo roster with readiness", !roster.isError && typeof roster.structuredContent?.ready === "number", `${roster.structuredContent?.ready}/${roster.structuredContent?.total} ready`);
// Naming a vendor: the server resolves its contact; exactly that vendor; never the whole roster.
// dry_run sends nothing. Guard: a server without dry_run would drop the flag and SEND, so skip there.
if (by.deal?.inputSchema?.properties?.dry_run) {
  const req = { what: "drop-off catering", quantity: 25, date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA", requirements: [] };
  const before = deals.structuredContent?.deals?.length;
  const one = await call("deal", { request: req, budget_usd: 500, businesses: ["Mission Eats"], dry_run: true });
  const would = one.structuredContent?.would_contact?.map((w) => w.name) ?? [];
  check("deal(businesses=['Mission Eats']) resolves exactly Mission Eats, no contact details needed (dry run)", !one.isError && would.length === 1 && would[0] === "Mission Eats", would.join(", ") || err(one)?.error?.code);
  const unknown = await call("deal", { request: req, budget_usd: 500, businesses: ["Taco Palace"], dry_run: true });
  check("an unknown vendor name starts nothing (no roster fallback)", err(unknown)?.error?.code === "unknown_business");
  check("dry runs started no deal", (await call("list_deals", { limit: 5 })).structuredContent?.deals?.length === before);
  const prof = await call("business_profile", { business: "Mission Eats" });
  const pc = prof.structuredContent ?? {};
  check("business_profile(Mission Eats): same business_ref deal takes, real quotes only (no seed samples)", pc.business_ref === "mission_eats" && pc.configured_vendor === true && pc.n_quotes > 0 && !/seed/i.test(prof.content?.[0]?.text ?? "") && !(pc.history ?? []).some((h) => /seed/i.test(h.note ?? "")), `${pc.n_quotes} real quotes, confidence ${pc.confidence}`);
  // Real-world discovery and evidence (read-only; dry runs only).
  const plumb = await call("discover", { category: "plumber", area: "Oakland, CA" });
  const pd = plumb.structuredContent?.public_discovery;
  check("discover(plumber): real listings or an explicit limitation; never demo caterers as results", !plumb.isError && ["ok", "not_configured", "rate_limited", "key_rejected", "unavailable"].includes(pd?.status) && !(plumb.structuredContent?.found ?? []).some((f) => /Mission Eats|Harbor Table|Sunset Kitchen/.test(f.name)), `${pd?.status}: ${(pd?.message ?? "").slice(0, 60)}`);
  const plumbDeal = await call("deal", { request: { ...req, what: "fix a leaking kitchen pipe", quantity: 1, unit: "job", area: "Oakland, CA" }, budget_usd: 400, dry_run: true });
  check("a plumbing deal never falls back to the catering demo vendors", err(plumbDeal)?.error?.code === "no_vendors_for_category");
  check("Mission Eats: verified responsive, evidence carries kinds and sources", ["verified_responsive", "authorized"].includes(pc.contact_status?.state) && (pc.evidence ?? []).some((e) => e.kind === "verified" && /Quoted Haggle/.test(e.statement)), pc.contact_status?.state);
  const harbor = (await call("business_profile", { business: "Harbor Table" })).structuredContent ?? {};
  check("Harbor Table: its real quote (stored under the mailbox's old name) is found via Haggle's own job records", harbor.n_quotes >= 1 && harbor.name === "Harbor Table", `${harbor.n_quotes ?? 0} real quote(s)`);
} else check("deal supports dry_run (named-vendor checks)", false, "server predates dry_run: named-vendor checks skipped, deal NOT called");
const cb = latest.structuredContent?.callbacks?.[0];
if (cb) check("call_back can't be authorized by a headless client (no call placed)", ["NO_HUMAN_CHANNEL", "callback_not_justified"].includes(err(await call("call_back", { job_id: latest.structuredContent.job_id, business_id: cb.business_id }))?.error?.code));
const blocked = await call("deal", { request: { what: "lunch catering", quantity: 40, date: "2026-10-22", area: "San Francisco, CA", requirements: [] }, businesses: [{ name: "Some Real Diner", email: "owner@realdiner.example" }], budget_usd: 1200 });
check("deal refuses a business outside the recipient allowlist (nothing sent)", err(blocked)?.error?.code === "recipient_not_allowed");
const body = JSON.stringify({ id: "evt_accept_forged", event_type: "imessage.received", timestamp: new Date().toISOString(), data: { message: { id: "x" } } });
const unsigned = await fetch(`${base}/webhooks/inkbox`, { method: "POST", body });
check("unsigned webhook rejected", unsigned.status === 401);
const ts = String(Math.floor(Date.now() / 1000));
const forged = await fetch(`${base}/webhooks/inkbox`, { method: "POST", body, headers: { "x-inkbox-signature": `sha256=${createHmac("sha256", "not-the-key").update(`r.${ts}.${body}`).digest("hex")}`, "x-inkbox-request-id": "r", "x-inkbox-timestamp": ts } });
check("forged-signature webhook rejected", forged.status === 401);

if (env.INKBOX_API_KEY) {
  const { Inkbox } = await import(new URL("../../node_modules/@inkbox/sdk/dist/index.js", import.meta.url));
  const ink = new Inkbox({ apiKey: env.INKBOX_API_KEY });
  const idn = await ink.getIdentity(env.INKBOX_IDENTITY || "haggle");
  const subs = (await ink.webhooks.subscriptions.list({ agentIdentityId: idn.id, scope: "identity" })).filter((s) => s.url.startsWith(base));
  const ev = new Set(subs.flatMap((s) => s.eventTypes));
  check("Inkbox webhook → this server with mail/call/iMessage/A2A events", ["message.received", "call.ended", "imessage.received", "a2a.sent_task.updated"].every((e) => ev.has(e)), [...ev].join(","));
  check("Inkbox buyer identity", !!idn.emailAddress, `${idn.agentHandle} <${idn.emailAddress}> phone:${idn.phoneNumber ? "own" : "none"} imessage:${idn.imessageEnabled}`);
}
if (env.STRIPE_SECRET_KEY) {
  const { verifyStripeTestSetup } = await import(new URL("../../packages/engine/src/payments/stripe.ts", import.meta.url));
  const v = await verifyStripeTestSetup({ secretKey: env.STRIPE_SECRET_KEY, customerId: env.STRIPE_CUSTOMER_ID, paymentMethodId: env.STRIPE_PAYMENT_METHOD_ID });
  check("Stripe test key + customer + attached card (read-only)", v.ok, v.checks.filter((c) => !c.ok).map((c) => c.check).join("; "));
}
if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/brain_profiles?select=business_id`, { headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` } });
  const n = r.ok ? (await r.json()).length : -1;
  check("brain profiles readable in Supabase (persistent store)", r.ok && n > 0, `HTTP ${r.status}, ${n} profiles`);
}
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} live read-only checks passed`);
process.exit(failed ? 1 : 0);
