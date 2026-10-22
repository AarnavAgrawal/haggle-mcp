// Workspace auth for the MCP endpoint (src/workspace.ts) and the workspace-create script's plan:
// tokens and connector secrets resolve to their workspace by SHA-256 hash; a wrong one never falls
// back to the default workspace; HAGGLE_AUTH=required refuses requests without credentials; only
// the bare handshake is open. In-memory store, no network.
import { describe, expect, it } from "vitest";
import { createMockEngine, DEFAULT_WORKSPACE_ID, InMemoryRepository } from "@haggle/engine";
import { authRequired, bearerToken, emailApprovalByCode, hashSecret, isHandshakeOnly, newSecret, outOfBandApprovals, resolveWorkspace } from "../src/workspace.ts";
import { planWorkspace } from "../scripts/workspace-create.ts";
import type { Runtime } from "../src/runtime.ts";

async function runtimeWith() {
  const repo = new InMemoryRepository();
  const plan = planWorkspace({ name: "Acme ops", approverPhone: "+14155550123", capUsd: 900, baseUrl: "https://haggle.example/" });
  await repo.insertWorkspace(plan.workspace);
  await repo.saveSettings(plan.settings, plan.workspace.id);
  const { engine } = createMockEngine({ repo });
  return { rt: { mode: "mock", engine } as unknown as Runtime, plan };
}

describe("workspace auth", () => {
  it("a bearer token or connector secret resolves to its workspace; unknown ones are refused", async () => {
    const { rt, plan } = await runtimeWith();
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${plan.token}` }, true)).toEqual({ ok: true, workspaceId: "ws_acme_ops", authenticated: true });
    const secret = plan.connectorUrl.match(/\/c\/([^/]+)\/mcp$/)![1]!;
    expect(await resolveWorkspace(rt, { connectorSecret: secret }, true)).toEqual({ ok: true, workspaceId: "ws_acme_ops", authenticated: true });
    expect(await resolveWorkspace(rt, { authorization: "Bearer hgw_wrong" }, false)).toEqual({ ok: false, reason: "unknown_credentials" });
    expect(await resolveWorkspace(rt, {}, true)).toEqual({ ok: false, reason: "missing_credentials" });
    expect(await resolveWorkspace(rt, {}, false)).toEqual({ ok: true, workspaceId: DEFAULT_WORKSPACE_ID, authenticated: false });
  });

  it("only hashes are stored; credentials are long and distinct; settings land on the workspace", async () => {
    const { rt, plan } = await runtimeWith();
    expect(plan.workspace.token_hash).toBe(hashSecret(plan.token));
    expect(JSON.stringify(plan.workspace)).not.toContain(plan.token);
    expect(plan.token).toMatch(/^hgw_[A-Za-z0-9_-]{32}$/);
    expect(newSecret("hgc")).not.toBe(newSecret("hgc"));
    expect(plan.connectorUrl).toMatch(/^https:\/\/haggle\.example\/c\/hgc_[A-Za-z0-9_-]{32}\/mcp$/);
    const s = await rt.engine.forWorkspace("ws_acme_ops").getSettings();
    expect(s).toMatchObject({ spending_cap_cents: 90_000, approver_phone: "+14155550123" });
  });

  it("validates the plan", () => {
    expect(() => planWorkspace({ name: "" })).toThrow(/--name/);
    expect(() => planWorkspace({ name: "x" })).toThrow(/ws_acme/); // id too short
    expect(() => planWorkspace({ name: "Acme", approverPhone: "415-555" })).toThrow(/E\.164/);
    expect(() => planWorkspace({ name: "Acme", timezone: "Mars/Olympus" })).toThrow();
    expect(planWorkspace({ name: "Bay Area Events!" }).workspace.id).toBe("ws_bay_area_events");
  });

  it("parses bearer headers and recognises the open handshake", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(isHandshakeOnly("POST", { jsonrpc: "2.0", id: 1, method: "initialize" })).toBe(true);
    expect(isHandshakeOnly("POST", [{ method: "notifications/initialized" }, { method: "ping" }])).toBe(true);
    expect(isHandshakeOnly("POST", [{ method: "initialize" }, { method: "tools/call" }])).toBe(false);
    expect(isHandshakeOnly("GET", { method: "initialize" })).toBe(false);
  });
});

describe("production policy (fail closed)", () => {
  it("live mode always requires a credential, whatever HAGGLE_AUTH says", () => {
    expect(authRequired({ HAGGLE_MODE: "live" })).toBe(true);
    expect(authRequired({ HAGGLE_MODE: "live", HAGGLE_AUTH: "open" })).toBe(true);
    expect(authRequired({ HAGGLE_MODE: "mock" })).toBe(false);
    expect(authRequired({ HAGGLE_MODE: "mock", HAGGLE_AUTH: "required" })).toBe(true);
  });

  it("live mode only takes out-of-band approvals; email code approval is opt-in", () => {
    expect(outOfBandApprovals({ HAGGLE_MODE: "live", HAGGLE_APPROVALS: "demo" })).toBe(true);
    expect(outOfBandApprovals({ HAGGLE_MODE: "mock" })).toBe(false);
    expect(outOfBandApprovals({ HAGGLE_MODE: "mock", HAGGLE_APPROVALS: "out_of_band" })).toBe(true);
    expect(emailApprovalByCode({})).toBe(false); // was on by default
    expect(emailApprovalByCode({ HAGGLE_EMAIL_APPROVAL_BY_CODE: "1" })).toBe(false);
    expect(emailApprovalByCode({ HAGGLE_EMAIL_APPROVAL_BY_CODE: "true" })).toBe(true);
  });

  it("a revoked workspace's token and connector secret stop resolving; rotation restores access with new secrets only", async () => {
    const { rt, plan } = await runtimeWith();
    const engine = rt.engine;
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${plan.token}` }, true)).toMatchObject({ ok: true, workspaceId: plan.workspace.id });
    await engine.revokeWorkspace(plan.workspace.id);
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${plan.token}` }, true)).toEqual({ ok: false, reason: "unknown_credentials" });
    const secret = plan.connectorUrl.match(/\/c\/([^/]+)\/mcp/)![1]!;
    expect(await resolveWorkspace(rt, { connectorSecret: secret }, true)).toEqual({ ok: false, reason: "unknown_credentials" });
    const fresh = newSecret("hgw");
    await engine.rotateWorkspaceCredentials(plan.workspace.id, hashSecret(fresh), hashSecret(newSecret("hgc")));
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${plan.token}` }, true)).toEqual({ ok: false, reason: "unknown_credentials" });
    expect(await resolveWorkspace(rt, { authorization: `Bearer ${fresh}` }, true)).toMatchObject({ ok: true, workspaceId: plan.workspace.id });
  });
});

describe("workspace-admin (operator script) arguments", () => {
  it("validates commands; the approver and cap change only here", async () => {
    const { planAdmin } = await import("../scripts/workspace-admin.ts");
    expect(planAdmin(["revoke", "--id", "ws_acme"])).toEqual({ kind: "revoke", id: "ws_acme" });
    expect(planAdmin(["set-approver", "--id", "ws_acme", "--phone", "+14155550123", "--email", "Ops@Acme.example"])).toEqual({ kind: "set-approver", id: "ws_acme", phone: "+14155550123", email: "ops@acme.example" });
    expect(planAdmin(["set-approver", "--id", "ws_acme", "--email", "none"])).toEqual({ kind: "set-approver", id: "ws_acme", email: null });
    expect(planAdmin(["set-cap", "--id", "ws_acme", "--usd", "1500"])).toEqual({ kind: "set-cap", id: "ws_acme", capCents: 150_000 });
    expect(() => planAdmin(["set-approver", "--id", "ws_acme", "--phone", "4155550123"])).toThrow(/E\.164/);
    expect(() => planAdmin(["set-cap", "--id", "ws_acme", "--usd", "-1"])).toThrow(/positive/);
    expect(() => planAdmin(["revoke", "--id", "acme"])).toThrow(/workspace id/);
    expect(() => planAdmin(["drop", "--id", "ws_acme"])).toThrow(/command/);
    expect(planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "Orders@Caterer.example", "--name", "Caterer", "--consent", "Owner agreed by phone"])).toEqual({ kind: "add-vendor", id: "ws_acme", contact: "orders@caterer.example", name: "Caterer", consent: "Owner agreed by phone" });
    expect(() => planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "orders@caterer.example", "--name", "Caterer"])).toThrow(/consent/);
    expect(() => planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "not-a-contact", "--name", "C", "--consent", "yes ok"])).toThrow(/contact/);
  });

  it("operator onboarding: add-vendor channels, show, remove-suppression (who and why), shared approver phones refused unless accepted", async () => {
    const { planAdmin, sharedApproverProblem, showText } = await import("../scripts/workspace-admin.ts");
    expect(planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "+1 (415) 555-0161", "--name", "Casa Lunch", "--consent", "Owner agreed by phone", "--channel", "text"])).toMatchObject({ contact: "+14155550161", channel: "imessage" });
    expect(() => planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "+14155550161", "--name", "C", "--consent", "agreed", "--channel", "email"])).toThrow(/doesn't fit/);
    expect(() => planAdmin(["add-vendor", "--id", "ws_acme", "--contact", "a@b.example", "--name", "C", "--consent", "agreed", "--channel", "fax"])).toThrow(/--channel/);
    expect(planAdmin(["show", "--id", "ws_acme"])).toEqual({ kind: "show", id: "ws_acme" });
    expect(planAdmin(["remove-suppression", "--contact", "Orders@Caterer.example", "--by", "Yash", "--why", "mailbox was full, not a hard bounce"])).toEqual({ kind: "remove-suppression", contact: "orders@caterer.example", by: "Yash", why: "mailbox was full, not a hard bounce" });
    expect(() => planAdmin(["remove-suppression", "--contact", "orders@caterer.example", "--by", "Yash"])).toThrow(/--why/);
    expect(() => planAdmin(["remove-suppression", "--contact", "orders@caterer.example", "--why", "vendor asked again"])).toThrow(/--by/);
    expect(planAdmin(["set-approver", "--id", "ws_acme", "--phone", "+14155550123", "--allow-shared-approver"])).toMatchObject({ allowShared: true });
    expect(sharedApproverProblem("+14155550123", "ws_acme", ["ws_acme"])).toBeNull();
    expect(sharedApproverProblem("+14155550123", "ws_acme", ["ws_other"])).toMatch(/already approves for ws_other.*--allow-shared-approver/);
    expect(sharedApproverProblem("+14155550123", "ws_acme", ["ws_other"], true)).toBeNull();
    const text = showText({
      workspace: { id: "ws_acme", name: "Acme", token_hash: "a".repeat(64), connector_secret_hash: null, timezone: "America/Los_Angeles", created_at: "2026-10-22T00:00:00.000Z" },
      settings: { spending_cap_cents: 150_000, approver_phone: "+14155550123", approver_email: null, default_area: null },
      vendors: [{ workspace_id: "ws_acme", contact: "orders@casalunch.example", name: "Casa Lunch", consent: "Owner agreed", added_by: "operator", created_at: "2026-10-22T00:00:00.000Z", channel: null }],
      suppressions: [{ contact: "orders@casalunch.example", reason: "bounce", job_id: null, evidence: null, created_at: "2026-10-22T01:00:00.000Z" }],
      sharedApprover: ["ws_other"],
    });
    expect(text).toMatch(/bearer token set, connector URL none/);
    expect(text).toMatch(/spending cap \$1500\.00/);
    expect(text).toMatch(/Casa Lunch <o•••@casalunch\.example> by email.*SUPPRESSED \(bounce/);
    expect(text).toMatch(/also approves for ws_other/);
    expect(text).not.toContain("a".repeat(64));
  });

  it("workspace-create plans the approver and cap in one command and warns when live approvals would be impossible", () => {
    expect(planWorkspace({ name: "Acme", approverPhone: "+14155550123", capUsd: 900 })).toMatchObject({ settings: { approver_phone: "+14155550123", spending_cap_cents: 90_000 }, warnings: [] });
    expect(planWorkspace({ name: "Acme" }).warnings[0]).toMatch(/approver-phone/);
  });
});
