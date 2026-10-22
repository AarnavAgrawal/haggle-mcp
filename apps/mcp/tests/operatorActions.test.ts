// Sprint 5 B: pilot onboarding and operator actions without hand-editing rows, over the same code the
// scripts run (workspace-create provisioning, workspace-admin, job-ops, quarantine) against the
// in-memory store. Every change is recorded in the operator log with who and why; none can approve,
// pay or name a payee. No database, no network.
import { describe, expect, it } from "vitest";
import { InMemoryRepository } from "@haggle/engine";
import { planWorkspace, provisionWorkspace } from "../scripts/workspace-create.ts";
import { accountable, planAdmin, runAdmin, showData, showText } from "../scripts/workspace-admin.ts";
import { logJobAction, planOps } from "../scripts/job-ops.ts";
import { planQuarantine } from "../scripts/quarantine.ts";
import { hashSecret } from "../src/workspace.ts";

const admin = (repo: InMemoryRepository, ...argv: string[]) => runAdmin(planAdmin(argv), repo);
const APPROVER = "+14155550123";
const plan = () => planWorkspace({ name: "Bay Events Co", approverPhone: APPROVER, capUsd: 2500, area: "San Francisco, CA", baseUrl: "https://haggle.example" });

describe("workspace-create: one-command provisioning", () => {
  it("dry run by default: nothing written, no secret shown", async () => {
    const repo = new InMemoryRepository();
    const p = plan();
    const r = await provisionWorkspace(p, repo, { apply: false, env: "staging" });
    expect(r.created).toBe(false);
    expect(r.text).toMatch(/^DRY RUN \[staging\]: would create workspace ws_bay_events_co/);
    expect(r.text).not.toContain(p.token);
    expect(r.text).not.toMatch(/hgc_/);
    expect(await repo.getWorkspace("ws_bay_events_co")).toBeNull();
  });

  it("--apply writes the credentials to a new file (stdout shows none), records who, ends with readiness; re-running is a no-op", async () => {
    const repo = new InMemoryRepository();
    const p = plan();
    const files: Record<string, string> = {};
    const writeFile = (path: string, text: string) => { if (path in files) throw new Error("EEXIST"); files[path] = text; };
    await expect(provisionWorkspace(p, repo, { apply: true, credentials: { file: "/tmp/creds.txt" }, writeFile })).rejects.toThrow(/--by is required/);
    await expect(provisionWorkspace(p, repo, { apply: true, by: "ops-yash", writeFile })).rejects.toThrow(/--credentials-file/);
    expect(await repo.getWorkspace("ws_bay_events_co")).toBeNull();
    const r = await provisionWorkspace(p, repo, { apply: true, by: "ops-yash", credentials: { file: "/tmp/creds.txt" }, env: "staging", writeFile });
    expect(r.created).toBe(true);
    expect(r.text).not.toContain(p.token);
    expect(r.text).not.toMatch(/\/c\/hgc_/);
    expect(r.text).toMatch(/Bearer token and connector URL: in \/tmp\/creds\.txt/);
    expect(r.text).toMatch(/The connector URL IS the credential/);
    expect(r.text).toMatch(/verify-approver --id ws_bay_events_co/);
    expect(r.text.trim().split("\n").filter((l) => !l.startsWith("WARNING")).at(-1)).toMatch(/\[(PASS|FAIL|WARN)\]/); // ends with the readiness check
    expect(r.text).toMatch(/Readiness: FAIL \(4\/5 checks\)/);
    expect(files["/tmp/creds.txt"]).toContain(`Bearer token:   ${p.token}`);
    expect(files["/tmp/creds.txt"]).toContain(p.connectorUrl);
    expect((await repo.getWorkspace("ws_bay_events_co"))!.token_hash).toBe(hashSecret(p.token));
    expect((await repo.listOperatorActions({ workspaceId: "ws_bay_events_co" }))[0]).toMatchObject({ action: "workspace_created", operator: "ops-yash" });

    // Idempotent: the same settings again change nothing and issue nothing (a fresh plan has new secrets).
    const again = plan();
    const r2 = await provisionWorkspace(again, repo, { apply: true, by: "ops-yash", credentials: { file: "/tmp/creds2.txt" }, writeFile });
    expect(r2.created).toBe(false);
    expect(r2.text).toMatch(/already exists with these settings.*nothing changed, no new credentials/);
    expect(files["/tmp/creds2.txt"]).toBeUndefined();
    expect((await repo.getWorkspace("ws_bay_events_co"))!.token_hash).toBe(hashSecret(p.token));

    // Different settings: refused with the command that changes each.
    const other = planWorkspace({ name: "Bay Events Co", approverPhone: "+14155550199", capUsd: 900, area: "San Francisco, CA", baseUrl: "https://haggle.example" });
    await expect(provisionWorkspace(other, repo, { apply: true, by: "ops", credentials: { print: true } })).rejects.toThrow(/different settings; nothing changed:[\s\S]*set-approver --id ws_bay_events_co --phone \+14155550199[\s\S]*set-cap --id ws_bay_events_co --usd 900\.00/);
  });

  it("--print-credentials shows them once; a localhost base URL is flagged outside development; a shared approver is refused", async () => {
    const repo = new InMemoryRepository();
    const p = planWorkspace({ name: "Acme Lunches", approverPhone: APPROVER, baseUrl: "http://localhost:3000" });
    const r = await provisionWorkspace(p, repo, { apply: true, by: "ops", credentials: { print: true }, env: "production" });
    expect(r.text).toContain(`Bearer token:   ${p.token}`);
    expect(r.text).toMatch(/WARNING: --base-url .* is http:\/\/localhost:3000 on a production database/);
    const q = planWorkspace({ name: "Other Co", approverPhone: APPROVER, baseUrl: "https://haggle.example" });
    await expect(provisionWorkspace(q, repo, { apply: false })).rejects.toThrow(/already approves for ws_acme_lunches/);
  });
});

describe("workspace-admin: roster with consent, approver verification, suspension, all recorded", () => {
  async function created() {
    const repo = new InMemoryRepository();
    await provisionWorkspace(plan(), repo, { apply: true, by: "ops-yash", credentials: { print: true } });
    return repo;
  }

  it("add / remove vendor: the consent and who are recorded; a removed vendor's consent stays in the log", async () => {
    const repo = await created();
    await admin(repo, "add-vendor", "--id", "ws_bay_events_co", "--contact", "events@harbortable.example", "--name", "Harbor Table", "--consent", "Maria (owner) agreed by phone 2026-10-20", "--by", "ops-yash");
    await admin(repo, "add-vendor", "--id", "ws_bay_events_co", "--contact", "events@harbortable.example", "--name", "Harbor Table", "--consent", "Maria re-confirmed by email 2026-10-22", "--by", "ops-aarnav");
    const rm = await admin(repo, "remove-vendor", "--id", "ws_bay_events_co", "--contact", "events@harbortable.example", "--by", "ops-yash", "--reason", "vendor asked to stop");
    expect(rm.text).toMatch(/its consent "Maria re-confirmed by email 2026-10-22" is kept in the operator log/);
    expect(await repo.listWorkspaceVendors("ws_bay_events_co")).toEqual([]);
    const log = await repo.listOperatorActions({ workspaceId: "ws_bay_events_co", actions: ["vendor_added", "vendor_removed"] });
    expect(log.map((x) => [x.action, x.operator])).toEqual([["vendor_removed", "ops-yash"], ["vendor_added", "ops-aarnav"], ["vendor_added", "ops-yash"]]);
    expect(log[0]!.detail).toMatchObject({ contact: "events@harbortable.example", consent: "Maria re-confirmed by email 2026-10-22" });
    expect(log[0]!.reason).toBe("vendor asked to stop");
    expect(log[1]!.detail).toMatchObject({ replaced_consent: "Maria (owner) agreed by phone 2026-10-20" });
    const history = await admin(repo, "history", "--id", "ws_bay_events_co");
    expect(history.text).toMatch(/vendor_removed\s+by ops-yash: vendor asked to stop/);
    expect(history.text).not.toContain("events@harbortable.example"); // contacts masked in the listing
  });

  it("approver verification: only for the current approver phone; an approver change invalidates it", async () => {
    const repo = await created();
    expect(() => planAdmin(["verify-approver", "--id", "ws_bay_events_co", "--phone", APPROVER, "--by", "ops"])).toThrow(/--how is required/);
    await expect(admin(repo, "verify-approver", "--id", "ws_bay_events_co", "--phone", "+14155550100", "--by", "ops", "--how", "texted a code; the approver read it back")).rejects.toThrow(/isn't this workspace's approver phone/);
    await admin(repo, "verify-approver", "--id", "ws_bay_events_co", "--phone", APPROVER, "--by", "ops-yash", "--how", "texted a code from my phone; she read it back on a call");
    let d = await showData(repo, "ws_bay_events_co");
    expect(d.approverVerified).toMatchObject({ phone: APPROVER, by: "ops-yash" });
    expect(showText(d)).toMatch(/Approver verification: verified by ops-yash/);
    await admin(repo, "set-approver", "--id", "ws_bay_events_co", "--phone", "+14155550188", "--by", "ops-yash", "--reason", "new office manager");
    d = await showData(repo, "ws_bay_events_co");
    expect(d.approverVerified).toBeNull();
    expect(showText(d)).toMatch(/Approver verification: NOT verified/);
    // Changing back to the old number doesn't revive the old verification either.
    await admin(repo, "set-approver", "--id", "ws_bay_events_co", "--phone", APPROVER, "--by", "ops-yash", "--reason", "back to Maria");
    expect((await showData(repo, "ws_bay_events_co")).approverVerified).toBeNull();
    await admin(repo, "verify-approver", "--id", "ws_bay_events_co", "--phone", APPROVER, "--by", "ops-yash", "--how", "texted a code from my phone; she read it back");
    await admin(repo, "unverify-approver", "--id", "ws_bay_events_co", "--by", "ops-yash", "--reason", "phone reported lost");
    expect((await showData(repo, "ws_bay_events_co")).approverVerified).toBeNull();
  });

  it("suspend / resume from the CLI; show says so; both need who and why", async () => {
    const repo = await created();
    expect(() => planAdmin(["suspend", "--id", "ws_bay_events_co", "--by", "ops"])).toThrow(/--reason is required/);
    expect(() => planAdmin(["suspend", "--id", "ws_bay_events_co", "--reason", "customer asked"])).toThrow(/--by is required/);
    const s = await admin(repo, "suspend", "--id", "ws_bay_events_co", "--by", "ops-yash", "--reason", "customer asked to pause");
    expect(s.text).toMatch(/SUSPENDED .*WORKSPACE_SUSPENDED/);
    expect(showText(await showData(repo, "ws_bay_events_co"))).toMatch(/SUSPENDED since .* by ops-yash: customer asked to pause/);
    await expect(admin(repo, "suspend", "--id", "ws_bay_events_co", "--by", "ops", "--reason", "again")).rejects.toThrow(/already suspended/);
    await admin(repo, "resume", "--id", "ws_bay_events_co", "--by", "ops-yash", "--reason", "customer ready again");
    expect((await showData(repo, "ws_bay_events_co")).suspension).toBeNull();
  });

  it("changes need an operator identity (--by) and a reason; reads don't", () => {
    expect(accountable(planAdmin(["show", "--id", "ws_acme"]))).toEqual({ kind: "show", id: "ws_acme" });
    expect(() => accountable(planAdmin(["revoke", "--id", "ws_acme"]))).toThrow(/--by is required/);
    expect(() => accountable(planAdmin(["revoke", "--id", "ws_acme", "--by", "ops-yash"]))).toThrow(/--reason is required for revoke/);
    expect(accountable(planAdmin(["revoke", "--id", "ws_acme", "--reason", "leaked token", "--by", "ops-yash"]))).toMatchObject({ by: "ops-yash", reason: "leaked token" });
    expect(accountable(planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "a@b.example", "--name", "A", "--consent", "agreed by phone 2026-10-20", "--by", "ops"]))).toMatchObject({ by: "ops" });
    expect(() => accountable(planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "a@b.example", "--name", "A", "--consent", "agreed by phone 2026-10-20"]))).toThrow(/--by is required/);
    expect(() => planAdmin(["revoke", "--id", "ws_acme", "--by", "x"])).toThrow(/--by must name/);
  });

  it("set-cap and remove-suppression are recorded", async () => {
    const repo = await created();
    await admin(repo, "set-cap", "--id", "ws_bay_events_co", "--usd", "900", "--by", "ops-yash", "--reason", "customer's budget limit");
    await repo.addSuppression({ contact: "x@vendor.example", reason: "bounce", job_id: null, evidence: "mailbox full" });
    await admin(repo, "remove-suppression", "--contact", "x@vendor.example", "--by", "ops-yash", "--why", "mailbox was full, not a hard bounce");
    expect((await repo.listOperatorActions({ workspaceId: "ws_bay_events_co", actions: ["cap_changed"] }))[0]!.detail).toEqual({ from_cents: 250_000, to_cents: 90_000 });
    expect((await repo.listOperatorActions({ actions: ["suppression_removed"] }))[0]).toMatchObject({ operator: "ops-yash", workspace_id: null });
  });
});

describe("job-ops and quarantine: the new commands", () => {
  it("job-ops callback / cancel parse; cancel is fail-safe-close (needs --confirm)", () => {
    expect(planOps(["callback", "--job", "job_abcdef12", "--business", "biz_abcdef1234", "--by", "ops", "--reason", "reviewed the quotes: cheaper real offer"])).toEqual({ kind: "callback", jobId: "job_abcdef12", businessId: "biz_abcdef1234", by: "ops", reason: "reviewed the quotes: cheaper real offer" });
    expect(() => planOps(["callback", "--job", "job_abcdef12", "--business", "biz_abcdef1234", "--by", "ops", "--reason", "short"])).toThrow(/--reason is required/);
    expect(() => planOps(["callback", "--job", "job_abcdef12", "--business", "biz_abcdef1234", "--reason", "reviewed the quotes carefully"])).toThrow(/--by is required/);
    expect(() => planOps(["cancel", "--job", "job_abcdef12", "--reason", "customer called", "--by", "ops"])).toThrow(/--confirm/);
    expect(planOps(["cancel", "--job", "job_abcdef12", "--reason", "customer called", "--by", "ops", "--confirm"])).toMatchObject({ kind: "fail-safe-close", jobId: "job_abcdef12" });
  });

  it("job-ops changes are written to the operator log with the job's workspace", async () => {
    const repo = new InMemoryRepository();
    await repo.insertWorkspace({ id: "ws_ops", name: "Ops", token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles" });
    const job = await repo.insertJob({ id: "job_logtest1", short_code: "LOGT", workspace_id: "ws_ops" } as never).catch(() => null);
    const jobId = job?.id ?? "job_logtest1";
    await logJobAction(repo, planOps(["review-job", "--job", jobId, "--note", "vendor asked to pause", "--by", "ops-yash"]));
    const [row] = await repo.listOperatorActions({ jobId });
    expect(row).toMatchObject({ action: "job_held", operator: "ops-yash", reason: "vendor asked to pause", job_id: jobId, workspace_id: "ws_ops" });
  });

  it("quarantine release-text parses; who and why are required", () => {
    expect(planQuarantine(["release-text", "--message", "msg_abcdef12", "--job", "job_abcdef12", "--by", "ops", "--why", "phoned the vendor to confirm"])).toEqual({ kind: "release-text", messageId: "msg_abcdef12", jobId: "job_abcdef12", by: "ops", why: "phoned the vendor to confirm" });
    expect(() => planQuarantine(["release-text", "--message", "msg_abcdef12", "--job", "job_abcdef12", "--by", "ops", "--why", "sure"])).toThrow(/--why is required/);
    expect(() => planQuarantine(["release-text", "--message", "msg_abcdef12", "--by", "ops", "--why", "phoned the vendor to confirm"])).toThrow(/--job/);
  });
});
