// Sprint 5 B: scripts/pilot-preflight.ts with fakes (the launch gate's dependencies) and the in-memory
// store (the same repository calls run on Postgres in operatorStore.pg.test.ts). Each check is
// PASS / WARN / FAIL / BLOCKED with a fix; exit codes 0 / 1 / 3; never a secret in the output.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findMigrationsDir, InMemoryRepository, isEngineMigration, recordOperatorAction, repoMigrations, type LedgerRow } from "@haggle/engine";
import type { GateDeps } from "../scripts/launch-gate.ts";
import { deploymentChecks, formatPreflight, parsePreflightArgs, runPreflight, type PreflightOptions } from "../scripts/pilot-preflight.ts";
import { planWorkspace, provisionWorkspace } from "../scripts/workspace-create.ts";
import { planAdmin, runAdmin } from "../scripts/workspace-admin.ts";

const DIR = findMigrationsDir(import.meta.dirname)!;
const FULL_LEDGER: LedgerRow[] = repoMigrations(DIR).filter((m) => isEngineMigration(m.name)).map((m) => ({ name: m.name, checksum: m.checksum, applied_at: "2026-10-22T00:00:00.000Z" }));
const SECRETS = /hunter2pw|SECRETVALUE|stagingref|hooks\.example|hgw_|hgc_/;
const APPROVER = "+14155550123";

const ENV_LINES = [
  "HAGGLE_ENV=staging", "HAGGLE_MODE=live", "INKBOX_API_KEY=ik_SECRETVALUE", "INKBOX_WEBHOOK_SECRET=whsec_SECRETVALUE", "ANTHROPIC_API_KEY=sk-ant-SECRETVALUE",
  "SUPABASE_DB_URL=postgres://u:hunter2pw@db.stagingref.supabase.co:5432/postgres", "HAGGLE_PROD_DB_HOSTS=prodref123", "HAGGLE_PAYMENTS=manual", "HAGGLE_BUILD_SHA=abc1234",
  "HAGGLE_ALERT_WEBHOOK_URL=https://hooks.example/SECRETVALUE", "HAGGLE_AI_MAX_CALLS_PER_JOB=60", "HAGGLE_AI_DAILY_TOKEN_BUDGET=3000000", "HAGGLE_CONTACT_HOURS=08:00-19:00", "HAGGLE_CONTACT_DAYS=mon-sat",
];
const envFile = (over: Record<string, string | null> = {}) => {
  const lines = ENV_LINES.filter((l) => !(l.split("=")[0]! in over));
  for (const [k, v] of Object.entries(over)) if (v !== null) lines.push(`${k}=${v}`);
  return lines.join("\n");
};

function gate(file = envFile(), ledger: LedgerRow[] | null = FULL_LEDGER, over: Partial<GateDeps> = {}): GateDeps {
  return { readFile: (p) => { if (p !== "staging.env") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); return file; }, processEnv: {}, migrationsDir: DIR, readLedger: async () => ledger, build: () => ({ builtAt: 2, newestSource: 1 }), ...over };
}
const opts = (o: Partial<PreflightOptions> = {}): PreflightOptions => ({ target: "staging", envFile: "staging.env", dbUrlEnv: "SUPABASE_DB_URL", workspaces: [], checkBuild: false, json: false, ...o });
const check = (r: { deployment: { name: string; status: string }[]; workspaces: { checks: { name: string; status: string }[] }[] }, name: string, ws?: number) => (ws === undefined ? r.deployment : r.workspaces[ws]!.checks).find((c) => c.name === name)?.status;

/** A workspace ready for a pilot: approver verified, three real vendors with consent. */
async function readyWorkspace(repo = new InMemoryRepository()) {
  await provisionWorkspace(planWorkspace({ name: "Bay Events Co", approverPhone: APPROVER, approverEmail: "ops@bayevents.co", capUsd: 2500, area: "San Francisco, CA", baseUrl: "https://haggle.example" }), repo, { apply: true, by: "ops-yash", credentials: { print: true } });
  const admin = (...argv: string[]) => runAdmin(planAdmin(argv), repo);
  await admin("verify-approver", "--id", "ws_bay_events_co", "--phone", APPROVER, "--by", "ops-yash", "--how", "texted a code from my phone; she read it back on a call");
  await admin("add-vendor", "--id", "ws_bay_events_co", "--contact", "events@harbortable-sf.com", "--name", "Harbor Table", "--consent", "Maria (owner) agreed by phone 2026-10-20", "--by", "ops-yash");
  await admin("add-vendor", "--id", "ws_bay_events_co", "--contact", "orders@goldengrill-sf.com", "--name", "Golden Grill", "--consent", "Sam (manager) agreed by email 2026-10-21", "--by", "ops-yash");
  await admin("add-vendor", "--id", "ws_bay_events_co", "--contact", "+14159871234", "--name", "Sunset Kitchen", "--consent", "Dev (owner) agreed in person 2026-10-21", "--channel", "text", "--by", "ops-yash");
  return repo;
}

describe("pilot preflight", () => {
  it("parses arguments; refuses bad ones (exit 2 in the script)", () => {
    expect(parsePreflightArgs(["--target", "staging", "--env-file", "s.env", "--db-url-env", "SUPABASE_DB_URL", "--workspace", "ws_acme", "--workspace", "ws_beta", "--json"])).toMatchObject({ target: "staging", workspaces: ["ws_acme", "ws_beta"], json: true });
    expect(() => parsePreflightArgs([])).toThrow(/usage/);
    expect(() => parsePreflightArgs(["--target", "staging", "--workspace", "ws_acme"])).toThrow(/--db-url-env/);
    expect(() => parsePreflightArgs(["--target", "staging", "--db-url-env", "X_DB", "--workspace", "acme"])).toThrow(/workspace id/);
    expect(() => parsePreflightArgs(["--target", "staging", "--check-webhooks"])).toThrow(/--webhook-url/);
  });

  it("a ready staging deployment and workspace: everything passes except what needs a provider look (BLOCKED, exit 3); no secret printed", async () => {
    const repo = await readyWorkspace();
    const r = await runPreflight(opts({ workspaces: ["ws_bay_events_co"] }), { gate: gate(), repo });
    const fails = [...r.deployment, ...r.workspaces[0]!.checks].filter((c) => c.status === "FAIL");
    expect(fails).toEqual([]);
    expect(r.deployment.filter((c) => c.status === "BLOCKED").map((c) => c.name)).toEqual(["webhook subscriptions"]);
    expect(r.exitCode).toBe(3);
    expect(check(r, "brain tenancy")).toBe("PASS");
    expect(r.deployment.find((c) => c.name === "brain tenancy")!.detail).toMatch(/scoped per workspace \(202_brain_tenancy\)/);
    expect(r.workspaces[0]!.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["credentials:PASS", "active:PASS", "approver:PASS", "approver verified:PASS", "spending cap:PASS", "vendors:PASS", "default area:PASS", "approver email:PASS"]);
    const out = formatPreflight(r) + JSON.stringify(r);
    expect(out).not.toMatch(SECRETS);
    expect(out).not.toContain("events@harbortable-sf.com");
    expect(formatPreflight(r)).toMatch(/pilot preflight \(staging\): BLOCKED/);
  });

  it("with the explicit read-only webhook check, a fully ready setup exits 0", async () => {
    const repo = await readyWorkspace();
    const listWebhooks = async () => [{ url: "https://haggle.example/webhooks/inkbox", eventTypes: ["message.received", "message.bounced", "message.failed", "call.ended", "imessage.received", "a2a.sent_task.updated"] }];
    const r = await runPreflight(opts({ workspaces: ["ws_bay_events_co"], checkWebhooks: true, webhookUrl: "https://haggle.example/webhooks/inkbox" }), { gate: gate(undefined, undefined, { listWebhooks }), repo });
    expect(check(r, "webhook subscriptions")).toBe("PASS");
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
  });

  it("workspace failures, each with its fix: suspended, unverified approver, too few usable vendors (simulated, weak consent, suppressed)", async () => {
    const repo = await readyWorkspace();
    const admin = (...argv: string[]) => runAdmin(planAdmin(argv), repo);
    await admin("add-vendor", "--id", "ws_bay_events_co", "--contact", "quotes@bay-catering.sim.haggle.dev", "--name", "Bay Catering", "--consent", "demo seller persona 2026-10-20", "--by", "ops");
    await admin("add-vendor", "--id", "ws_bay_events_co", "--contact", "deli@quick-deli-sf.com", "--name", "Quick Deli", "--consent", "yes", "--by", "ops");
    await repo.addSuppression({ contact: "orders@goldengrill-sf.com", reason: "opt_out", job_id: null, evidence: "STOP" });
    await admin("set-approver", "--id", "ws_bay_events_co", "--phone", "+14155550188", "--by", "ops", "--reason", "new office manager");
    await admin("suspend", "--id", "ws_bay_events_co", "--by", "ops", "--reason", "billing question");
    const r = await runPreflight(opts({ workspaces: ["ws_bay_events_co", "ws_missing"] }), { gate: gate(), repo });
    const ws = r.workspaces[0]!.checks;
    expect(ws.find((c) => c.name === "active")).toMatchObject({ status: "FAIL", fix: expect.stringMatching(/workspace-admin\.ts resume --id ws_bay_events_co/) });
    expect(ws.find((c) => c.name === "approver verified")).toMatchObject({ status: "BLOCKED", fix: expect.stringMatching(/verify-approver --id ws_bay_events_co --phone \+14155550188/) });
    const vendors = ws.find((c) => c.name === "vendors")!;
    expect(vendors).toMatchObject({ status: "FAIL", fix: expect.stringMatching(/add 1 more real vendor/) });
    expect(vendors.detail).toMatch(/2 usable of 5/);
    expect(vendors.detail).toMatch(/Bay Catering .*simulated contact \(the simulated demo fleet\)/);
    expect(vendors.detail).toMatch(/Quick Deli .*doesn't say who agreed/);
    expect(vendors.detail).toMatch(/Golden Grill .*suppressed/);
    expect(r.workspaces[1]!.checks[0]).toMatchObject({ name: "workspace", status: "FAIL" });
    expect(r.exitCode).toBe(1);
    expect(formatPreflight(r)).toMatch(/NOT READY/);
  });

  it("deployment failures: payments not manual, contact window off, whole-domain allowlist, no alert webhook, demo vendors on production; the ledger behind", async () => {
    const env = { HAGGLE_ENV: "production", HAGGLE_PAYMENTS: undefined, HAGGLE_CONTACT_HOURS: "off", HAGGLE_ALLOWED_RECIPIENTS: "@gmail.com,ops@bayevents.co", HAGGLE_ALERT_WEBHOOK_URL: undefined, HAGGLE_DEMO_FLEET: "Harbor Table <h@inkboxmail.com>", INKBOX_API_KEY: "x", INKBOX_WEBHOOK_SECRET: undefined };
    const byName = Object.fromEntries(deploymentChecks(env, "production").map((c) => [c.name, c]));
    expect(byName.payments).toMatchObject({ status: "FAIL", fix: expect.stringMatching(/HAGGLE_PAYMENTS=manual/) });
    expect(byName["contact window"]!.status).toBe("FAIL");
    expect(byName["allowed recipients"]!.status).toBe("FAIL");
    expect(byName["alert webhook"]!.status).toBe("FAIL");
    expect(byName["simulated vendors"]!.status).toBe("FAIL");
    expect(byName["webhook secret"]!.status).toBe("FAIL");
    expect(byName["inkbox identity"]!.status).toBe("PASS");
    // Staging: the same gaps warn where a rehearsal can live with them.
    expect(Object.fromEntries(deploymentChecks(env, "staging").map((c) => [c.name, c.status]))).toMatchObject({ "contact window": "WARN", "allowed recipients": "WARN", "alert webhook": "WARN", "simulated vendors": "WARN" });
    // The ledger missing 119 (the operator log) fails the migrations check.
    const behind = FULL_LEDGER.filter((l) => !l.name.startsWith("119_"));
    const r = await runPreflight(opts(), { gate: gate(undefined, behind) });
    expect(r.deployment.find((c) => c.name === "migrations")).toMatchObject({ status: "FAIL", detail: expect.stringMatching(/pending: 119_engine_pilot\.sql/) });
    expect(r.exitCode).toBe(1);
  });

  it("a development target is refused for a pilot; a workspace check can't run without the database", async () => {
    const r = await runPreflight(opts({ target: "development", workspaces: ["ws_acme"] }), { gate: gate(envFile({ HAGGLE_ENV: "development" })), repo: null });
    expect(check(r, "pilot target")).toBe("FAIL");
    expect(check(r, "database", 0)).toBe("FAIL");
  });

  it("operator-log facts come from the store: a verification for another phone doesn't count", async () => {
    const repo = await readyWorkspace();
    await recordOperatorAction(repo, { action: "approver_verified", operator: "ops", reason: "verified the wrong number", workspaceId: "ws_bay_events_co", detail: { phone: "+14155550999" } });
    const r = await runPreflight(opts({ workspaces: ["ws_bay_events_co"] }), { gate: gate(), repo });
    expect(check(r, "approver verified", 0)).toBe("BLOCKED");
  });

  it("the script: usage error exits 2; it loads under plain node", () => {
    const r = spawnSync(process.execPath, ["scripts/pilot-preflight.ts"], { cwd: join(import.meta.dirname, ".."), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: pilot-preflight\.ts/);
  }, 60_000);
});
