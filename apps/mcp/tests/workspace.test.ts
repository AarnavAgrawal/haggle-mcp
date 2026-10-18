// Workspace auth for the MCP endpoint (src/workspace.ts) and the workspace-create script's plan:
// tokens and connector secrets resolve to their workspace by SHA-256 hash; a wrong one never falls
// back to the default workspace; HAGGLE_AUTH=required refuses requests without credentials; only
// the bare handshake is open. In-memory store, no network.
import { describe, expect, it } from "vitest";
import { createMockEngine, DEFAULT_WORKSPACE_ID, InMemoryRepository } from "@haggle/engine";
import { bearerToken, hashSecret, isHandshakeOnly, newSecret, resolveWorkspace } from "../src/workspace.ts";
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
