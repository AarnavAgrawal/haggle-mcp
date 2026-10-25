// Pilot preflight: can this deployment, and each named workspace, run a real pilot deal end to end
// with no developer step? One run, every check, each PASS / WARN / FAIL / BLOCKED with the exact fix.
// BLOCKED = needs something outside this session (a provider dashboard, CI, another person).
// Exit 0 = nothing failed or blocked (warnings allowed), 1 = something failed, 3 = only blocked
// items remain, 2 = usage error. Prints names, counts and masked contacts only, never a secret or URL.
//
//   npx tsx apps/mcp/scripts/pilot-preflight.ts --target staging|production --env-file <the target's env file> \
//       --db-url-env SUPABASE_DB_URL [--workspace ws_acme ...] [--check-build] [--json]
//       [--check-webhooks --webhook-url https://<server>/webhooks/inkbox]   explicit, read-only: lists the
//                                     buyer identity's Inkbox subscriptions (launch-gate's check); off by default
//
// Deployment checks: everything launch-gate.ts checks (config via src/config.ts checkConfig, the
// migration ledger read-only, the production-database guard), plus the pilot's own: manual payments
// only, the vendor-contact window, webhook signing secret and Inkbox identity configured (presence
// only: nothing is called), HAGGLE_ALLOWED_RECIPIENTS not wider than named contacts, an alert
// webhook, no simulated vendors configured on production, and the known brain-tenancy gap.
// Workspace checks: exists, credentials active, not suspended, approver set and verified, cap,
// at least 3 vendors with valid contacts and recorded consent (not suppressed, not simulated), area.
// Reads the database only. Never calls Stripe, Anthropic or the MCP server; Inkbox only with
// --check-webhooks (a read-only listing), otherwise the subscription check is BLOCKED.
import "./dbGuard.ts"; // refuses a production SUPABASE_DB_URL outside HAGGLE_ENV=production (src/config.ts)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { approverVerification, assessRoster, contactWindowFromEnv, parseFleet, PostgresRepository, workspaceSuspension, type Repository } from "@haggle/engine";
import { HAGGLE_ENVS, prodDbGuard, type HaggleEnv } from "../src/config.ts";
import { parseVendorConfig } from "../src/vendors.ts";
import { parseEnvFile, realDeps, runLaunchGate, type GateDeps, type GateResult } from "./launch-gate.ts";

type Env = Record<string, string | undefined>;
export type PreflightStatus = "PASS" | "WARN" | "FAIL" | "BLOCKED";
export interface PreflightCheck { name: string; status: PreflightStatus; detail: string; fix?: string }
export interface PreflightResult {
  ok: boolean;
  exitCode: 0 | 1 | 3;
  target: HaggleEnv;
  deployment: PreflightCheck[];
  workspaces: { id: string; checks: PreflightCheck[] }[];
  summary: Record<PreflightStatus, number>;
}
export interface PreflightOptions { target: HaggleEnv; envFile?: string; dbUrlEnv?: string; workspaces: string[]; checkBuild: boolean; json: boolean; checkWebhooks?: boolean; webhookUrl?: string }
export type PreflightRepo = Pick<Repository, "getWorkspace" | "getSettings" | "listWorkspaceVendors" | "findSuppressions" | "listWorkspacesByApproverPhone" | "listOperatorActions" | "appendOperatorAction">;
export interface PreflightDeps { gate: GateDeps; repo?: PreflightRepo | null; now?: () => Date }

/** Pilots need at least this many consenting vendors with valid contacts (docs/pilot-onboarding.md). */
export const MIN_PILOT_VENDORS = 3;

const val = (argv: string[], n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

export function parsePreflightArgs(argv: string[]): PreflightOptions {
  const usage = "usage: pilot-preflight.ts --target staging|production --env-file <file> --db-url-env SUPABASE_DB_URL [--workspace ws_x ...] [--check-build] [--json]";
  const target = val(argv, "target")?.toLowerCase();
  if (!target || !(HAGGLE_ENVS as readonly string[]).includes(target)) throw new Error(usage);
  const envFile = val(argv, "env-file");
  if (argv.includes("--env-file") && !envFile) throw new Error("--env-file needs a path");
  const dbUrlEnv = val(argv, "db-url-env");
  if (dbUrlEnv !== undefined && !/^[A-Z][A-Z0-9_]{2,60}$/.test(dbUrlEnv)) throw new Error("--db-url-env must name an environment variable");
  const workspaces = argv.flatMap((a, i) => (a === "--workspace" ? [argv[i + 1] ?? ""] : []));
  for (const w of workspaces) if (!/^ws_[a-z0-9_]{3,40}$/.test(w)) throw new Error(`--workspace must be a workspace id like ws_acme (got ${w || "nothing"})`);
  if (workspaces.length && !dbUrlEnv) throw new Error("--workspace needs --db-url-env (the workspace checks read the database)");
  const checkWebhooks = argv.includes("--check-webhooks");
  const webhookUrl = val(argv, "webhook-url");
  if (checkWebhooks && !(webhookUrl && /^https:\/\/[^\s/]+\/.*webhooks\/inkbox$/.test(webhookUrl))) throw new Error("--check-webhooks needs --webhook-url https://<server>/webhooks/inkbox");
  return { target: target as HaggleEnv, ...(envFile ? { envFile } : {}), ...(dbUrlEnv ? { dbUrlEnv } : {}), workspaces, checkBuild: argv.includes("--check-build"), json: argv.includes("--json"), ...(checkWebhooks ? { checkWebhooks, webhookUrl: webhookUrl! } : {}) };
}

const mask = (c: string) => (c.includes("@") ? c.replace(/^(.).*?@/, "$1•••@") : `${c.slice(0, 3)}•••${c.slice(-2)}`);
const set = (v: string | undefined) => !!v && v.trim() !== "";

/** Contacts the operator configured as demo vendors on this deployment (never real pilot vendors). */
export function demoContacts(env: Env): string[] {
  const vendors = Object.values(parseVendorConfig(env.HAGGLE_DEMO_VENDORS).contacts).flatMap((c) => [c.email, c.phone].filter((x): x is string => !!x));
  let fleet: string[] = [];
  try { fleet = parseFleet(env.HAGGLE_DEMO_FLEET).map((f) => f.email); } catch { /* reported by config */ }
  return [...vendors, ...fleet].map((c) => c.toLowerCase());
}

/** launch-gate's checks, as preflight checks (its skips are things this run can't see). */
function fromGate(g: GateResult, o: PreflightOptions): PreflightCheck[] {
  return g.checks.map((c) => {
    if (c.name === "tests last green") return { name: c.name, status: "WARN" as const, detail: "not checkable from here", fix: "confirm CI (GitHub Actions: CI) is green on the exact commit deployed" };
    if (c.name === "webhook subscriptions" && c.status === "skip") return { name: c.name, status: "BLOCKED" as const, detail: "the Inkbox subscription isn't read by this check (no provider calls)", fix: "check the buyer identity's subscription in the Inkbox dashboard (message.received, call.ended, imessage.received, message.bounced), or run launch-gate.ts --check-webhooks --webhook-url https://<server>/webhooks/inkbox (read-only)" };
    if (c.name === "build" && c.status === "skip") return { name: c.name, status: "WARN" as const, detail: "not checked (--check-build)", fix: "the deployed build is the hosting platform's; pass --check-build to check a local one" };
    if (c.name === "migrations" && c.status === "skip") return { name: c.name, status: "FAIL" as const, detail: "the migration ledger wasn't read", fix: "pass --db-url-env SUPABASE_DB_URL (read-only)" };
    const status: PreflightStatus = c.status === "pass" ? "PASS" : c.status === "warn" ? "WARN" : c.status === "skip" ? "WARN" : "FAIL";
    const fix = c.name === "config" && status === "FAIL" ? `fix the env file for ${o.target} (docs/env-manifest.md), then re-run` : c.name === "migrations" && status === "FAIL" ? "apply the pending engine migrations in order (docs/deployment.md §4), then re-run" : undefined;
    return { name: c.name, status, detail: c.detail, ...(fix ? { fix } : {}) };
  });
}

/** The pilot's own deployment checks, from the target's env file (values never printed). */
export function deploymentChecks(env: Env, target: HaggleEnv): PreflightCheck[] {
  const prod = target === "production";
  const out: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => out.push(c);
  if (target === "development") add({ name: "pilot target", status: "FAIL", detail: "a pilot runs on staging or production", fix: "--target staging (rehearsal) or production" });
  add(env.HAGGLE_PAYMENTS?.trim() === "manual"
    ? { name: "payments", status: "PASS", detail: "manual: the customer pays the vendor directly; no money moves through Haggle" }
    : { name: "payments", status: "FAIL", detail: `HAGGLE_PAYMENTS is ${set(env.HAGGLE_PAYMENTS) ? "not manual" : "unset"}`, fix: "set HAGGLE_PAYMENTS=manual (the pilot never charges)" });
  if (env.HAGGLE_ENABLE_PAYMENTS?.trim().toLowerCase() === "true" || set(env.STRIPE_SECRET_KEY)) add({ name: "stripe", status: "WARN", detail: "Stripe test-mode variables are set; HAGGLE_PAYMENTS=manual overrides them", fix: "remove HAGGLE_ENABLE_PAYMENTS and STRIPE_* from the pilot's env" });
  const w = contactWindowFromEnv(env);
  add(w
    ? { name: "contact window", status: "PASS", detail: `vendors contacted ${String(Math.floor(w.startMinute / 60)).padStart(2, "0")}:${String(w.startMinute % 60).padStart(2, "0")}-${String(Math.floor(w.endMinute / 60)).padStart(2, "0")}:${String(w.endMinute % 60).padStart(2, "0")} on ${w.days.length} day(s) a week${w.timezone ? `, ${w.timezone}` : ""}` }
    : { name: "contact window", status: prod ? "FAIL" : "WARN", detail: "HAGGLE_CONTACT_HOURS=off: vendors may be contacted at any hour", fix: "set HAGGLE_CONTACT_HOURS (e.g. 08:00-19:00) and HAGGLE_CONTACT_DAYS (e.g. mon-sat)" });
  add(set(env.INKBOX_WEBHOOK_SECRET)
    ? { name: "webhook secret", status: "PASS", detail: "INKBOX_WEBHOOK_SECRET set (presence only)" }
    : { name: "webhook secret", status: "FAIL", detail: "INKBOX_WEBHOOK_SECRET is not set: inbound webhooks can't be verified", fix: "copy the signing secret from the Inkbox dashboard into the env" });
  add(set(env.INKBOX_API_KEY)
    ? { name: "inkbox identity", status: "PASS", detail: `INKBOX_API_KEY set; identity ${env.INKBOX_IDENTITY?.trim() || "haggle (default)"} (presence only; Inkbox not contacted)` }
    : { name: "inkbox identity", status: "FAIL", detail: "INKBOX_API_KEY is not set", fix: "set INKBOX_API_KEY (and INKBOX_IDENTITY if not haggle)" });
  const allow = (env.HAGGLE_ALLOWED_RECIPIENTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const wide = allow.filter((a) => a.startsWith("@") || a === "*");
  add(!allow.length
    ? { name: "allowed recipients", status: "PASS", detail: "unset: deals reach only each workspace's own consenting vendors" }
    : wide.length
      ? { name: "allowed recipients", status: prod ? "FAIL" : "WARN", detail: `${wide.length} whole-domain entr${wide.length === 1 ? "y" : "ies"}: every workspace could reach any address there`, fix: "list exact contacts only, or leave it unset and add vendors per workspace (workspace-admin add-vendor)" }
      : { name: "allowed recipients", status: "WARN", detail: `${allow.length} server-wide contact(s) any workspace may reach`, fix: "prefer per-workspace vendors with recorded consent; keep this for operator test contacts only" });
  add(set(env.HAGGLE_ALERT_WEBHOOK_URL)
    ? { name: "alert webhook", status: "PASS", detail: "HAGGLE_ALERT_WEBHOOK_URL set (presence only; nothing posted)" }
    : { name: "alert webhook", status: prod ? "FAIL" : "WARN", detail: "no alert webhook: stuck deals and failures reach nobody", fix: "set HAGGLE_ALERT_WEBHOOK_URL to a Slack incoming webhook the operator watches" });
  const demo = demoContacts(env);
  add(!demo.length
    ? { name: "simulated vendors", status: "PASS", detail: "no demo vendors configured" }
    : { name: "simulated vendors", status: prod ? "FAIL" : "WARN", detail: `${demo.length} demo vendor contact(s) configured (HAGGLE_DEMO_VENDORS / HAGGLE_DEMO_FLEET)`, fix: "remove them from a pilot deployment; real vendors go on each workspace with consent" });
  add({ name: "brain tenancy", status: "WARN", detail: "known gap: learned business profiles are shared across workspaces (ask, check_price, price checks, negotiation hints)", fix: "packages/core + brain change (Aarnav, docs/sprint-4-report.md §9); with one pilot workspace the effect is nil" });
  return out;
}

/** Every per-workspace pilot requirement, read from the database. */
export async function workspaceChecks(repo: PreflightRepo, id: string, o: { live: boolean; env: Env }): Promise<PreflightCheck[]> {
  const ws = await repo.getWorkspace(id);
  if (!ws) return [{ name: "workspace", status: "FAIL", detail: `no workspace ${id}`, fix: `workspace-create.ts --id ${id} --name "<customer>" --approver-phone +1... --apply ...` }];
  const out: PreflightCheck[] = [];
  const add = (c: PreflightCheck) => out.push(c);
  const [settings, vendors, suspension] = await Promise.all([repo.getSettings(id), repo.listWorkspaceVendors(id), workspaceSuspension(repo, id)]);
  add(ws.revoked_at ? { name: "credentials", status: "FAIL", detail: `revoked ${ws.revoked_at}`, fix: `workspace-admin.ts rotate --id ${id} --by <you> --reason "<why>"` }
    : !ws.token_hash && !ws.connector_secret_hash ? { name: "credentials", status: "FAIL", detail: "none issued", fix: `workspace-admin.ts rotate --id ${id} --by <you> --reason "first credentials"` }
    : { name: "credentials", status: "PASS", detail: "active" });
  add(suspension ? { name: "active", status: "FAIL", detail: `suspended since ${suspension.at} by ${suspension.by}: ${suspension.reason}`, fix: `workspace-admin.ts resume --id ${id} --by <you> --reason "<why>"` } : { name: "active", status: "PASS", detail: "not suspended" });
  const phone = settings?.approver_phone ?? null;
  if (!phone) add({ name: "approver", status: "FAIL", detail: "no approver phone: nothing can be approved on a live server", fix: `workspace-admin.ts set-approver --id ${id} --phone +1... --by <you> --reason "<who>"` });
  else {
    const shared = (await repo.listWorkspacesByApproverPhone(phone)).filter((w) => w !== id);
    add({ name: "approver", status: shared.length ? "WARN" : "PASS", detail: `${mask(phone)}${shared.length ? `, also approves for ${shared.length} other workspace(s): its texts are held unless they carry the deal code` : ""}`, ...(shared.length ? { fix: "give each workspace its own approver phone" } : {}) });
    const v = await approverVerification(repo, id, phone);
    add(v ? { name: "approver verified", status: "PASS", detail: `by ${v.by} at ${v.at.slice(0, 10)}` }
      : { name: "approver verified", status: "BLOCKED", detail: "the approver phone hasn't been verified as the approver's", fix: `confirm it with the approver (e.g. text a code from your phone; they read it back), then workspace-admin.ts verify-approver --id ${id} --phone ${phone} --by <you> --how "<how>"` });
  }
  const ceiling = Number(o.env.HAGGLE_SPENDING_CAP_CEILING_CENTS ?? 500_000);
  add(!settings ? { name: "spending cap", status: "FAIL", detail: "no settings row", fix: `workspace-admin.ts set-cap --id ${id} --usd 1500 --by <you> --reason "<why>"` }
    : settings.spending_cap_cents > ceiling ? { name: "spending cap", status: "WARN", detail: `$${(settings.spending_cap_cents / 100).toFixed(2)} is above the server ceiling; the ceiling applies`, fix: `workspace-admin.ts set-cap --id ${id} --usd <amount>` }
    : { name: "spending cap", status: "PASS", detail: `$${(settings.spending_cap_cents / 100).toFixed(2)} per order (manual payment: the customer pays the vendor)` });
  const suppressed = new Set((await repo.findSuppressions(vendors.map((v) => v.contact))).map((s) => s.contact));
  const assessed = assessRoster(vendors, { suppressed, live: o.live, demoContacts: demoContacts(o.env) });
  const usable = assessed.filter((a) => a.usable);
  const bad = assessed.filter((a) => !a.usable);
  add({
    name: "vendors", status: usable.length >= MIN_PILOT_VENDORS ? "PASS" : "FAIL",
    detail: `${usable.length} usable of ${vendors.length}${bad.length ? `; not usable: ${bad.map((a) => `${a.vendor.name} <${mask(a.vendor.contact)}> (${a.problems.join("; ")})`).join(", ")}` : ""}`,
    ...(usable.length >= MIN_PILOT_VENDORS ? {} : { fix: `add ${MIN_PILOT_VENDORS - usable.length} more real vendor(s) that agreed to be contacted: workspace-admin.ts add-vendor --id ${id} --contact <email or +1...> --name "<Vendor>" --consent "<who agreed, how, when>" --by <you>` }),
  });
  if (bad.length && usable.length >= MIN_PILOT_VENDORS) add({ name: "vendor problems", status: "WARN", detail: `${bad.length} vendor(s) won't be contacted`, fix: `workspace-admin.ts remove-vendor --id ${id} --contact <contact> --by <you> --reason "<why>", or fix their consent / contact` });
  add(settings?.default_area ? { name: "default area", status: "PASS", detail: settings.default_area } : { name: "default area", status: "WARN", detail: "none: every request must say where", fix: "set it at creation (workspace-create --area), or the customer sets it in the client's settings" });
  add(settings?.approver_email ? { name: "approver email", status: "PASS", detail: mask(settings.approver_email) } : { name: "approver email", status: "WARN", detail: "none: receipts and updates go by text only" });
  return out;
}

const tally = (all: PreflightCheck[]): Record<PreflightStatus, number> => ({ PASS: 0, WARN: 0, FAIL: 0, BLOCKED: 0, ...Object.fromEntries((["PASS", "WARN", "FAIL", "BLOCKED"] as const).map((s) => [s, all.filter((c) => c.status === s).length])) }) as Record<PreflightStatus, number>;

export async function runPreflight(o: PreflightOptions, d: PreflightDeps): Promise<PreflightResult> {
  const gate = await runLaunchGate({ target: o.target, ...(o.envFile ? { envFile: o.envFile } : {}), ...(o.dbUrlEnv ? { dbUrlEnv: o.dbUrlEnv } : {}), allowAhead: false, checkWebhooks: !!o.checkWebhooks, ...(o.webhookUrl ? { webhookUrl: o.webhookUrl } : {}), skipConfig: false, skipBuild: !o.checkBuild, json: false }, d.gate);
  let env: Env = {};
  if (o.envFile) try { env = parseEnvFile(d.gate.readFile(o.envFile)); } catch { /* the gate's config check reported it */ }
  const deployment = [...fromGate(gate, o), ...(o.envFile ? deploymentChecks(env, o.target) : [])];
  const workspaces: PreflightResult["workspaces"] = [];
  for (const id of o.workspaces) {
    if (!d.repo) { workspaces.push({ id, checks: [{ name: "database", status: "FAIL", detail: "the database couldn't be opened for the workspace checks (see the migrations check)", fix: "fix --db-url-env, then re-run" }] }); continue; }
    try {
      workspaces.push({ id, checks: await workspaceChecks(d.repo, id, { live: o.target !== "development", env }) });
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      workspaces.push({ id, checks: [{ name: "database", status: "FAIL", detail: `workspace checks failed (${typeof code === "string" ? code : "error"})`, fix: "apply the pending migrations (119 for operator actions), then re-run" }] });
    }
  }
  const summary = tally([...deployment, ...workspaces.flatMap((w) => w.checks)]);
  const exitCode = summary.FAIL ? 1 : summary.BLOCKED ? 3 : 0;
  return { ok: exitCode === 0, exitCode, target: o.target, deployment, workspaces, summary };
}

export function formatPreflight(r: PreflightResult): string {
  const line = (c: PreflightCheck) => `${c.status.padEnd(7)} ${c.name} - ${c.detail}${c.fix ? `\n          fix: ${c.fix}` : ""}`;
  return [
    `Deployment (${r.target}):`, ...r.deployment.map(line),
    ...r.workspaces.flatMap((w) => ["", `Workspace ${w.id}:`, ...w.checks.map(line)]),
    "",
    `pilot preflight (${r.target}): ${r.exitCode === 0 ? "READY" : r.exitCode === 3 ? "BLOCKED (only items outside this session remain)" : "NOT READY"} - ${r.summary.PASS} pass, ${r.summary.WARN} warn, ${r.summary.FAIL} fail, ${r.summary.BLOCKED} blocked`,
  ].join("\n");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/pilot-preflight.ts")) {
  let opts: PreflightOptions;
  try {
    opts = parsePreflightArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const deps = realDeps(fileURLToPath(new URL("../../..", import.meta.url)));
  if (!opts.checkWebhooks) delete deps.listWebhooks; // no provider call unless explicitly asked (read-only)
  let repo: PostgresRepository | null = null;
  if (opts.dbUrlEnv && opts.workspaces.length) {
    let fileEnv: Env = {};
    if (opts.envFile) try { fileEnv = parseEnvFile(readFileSync(opts.envFile, "utf8")); } catch { /* reported by the gate */ }
    const source: Env = { ...process.env, ...fileEnv };
    const url = source[opts.dbUrlEnv]?.trim();
    // The same guard as the ledger read: a production database only for --target production.
    if (url && !prodDbGuard({ ...source, HAGGLE_ENV: opts.target }, [opts.dbUrlEnv]).length) {
      const schema = source.HAGGLE_DB_SCHEMA?.trim();
      repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
    }
  }
  runPreflight(opts, { gate: deps, repo }).then((r) => {
    console.log(opts.json ? JSON.stringify(r) : formatPreflight(r));
    process.exitCode = r.exitCode;
  }).catch((e) => {
    const code = (e as { code?: unknown })?.code;
    console.error(`pilot preflight failed: ${typeof code === "string" ? code : (e as Error)?.name ?? "error"}`);
    process.exitCode = 1;
  }).finally(() => repo?.close().catch(() => {}));
}
