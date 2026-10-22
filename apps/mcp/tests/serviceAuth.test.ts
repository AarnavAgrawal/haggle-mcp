// The web app's server-to-server credential (src/workspace.ts): HAGGLE_SERVICE_TOKEN plus the
// x-haggle-workspace header selects a workspace, only with the right token, only an existing,
// unrevoked one; and service onboarding creates one workspace per owner. In-memory store, no network.
import { describe, expect, it } from "vitest";
import { createMockEngine, InMemoryRepository } from "@haggle/engine";
import { planServiceWorkspace, resolveWorkspace, serviceTokenValid } from "../src/workspace.ts";
import type { Runtime } from "../src/runtime.ts";

const SECRET = "svc_0123456789abcdef0123456789abcdef";
const env = { HAGGLE_SERVICE_TOKEN: SECRET } as NodeJS.ProcessEnv;

async function runtime() {
  const { engine } = createMockEngine({ repo: new InMemoryRepository() });
  const rt = { mode: "mock", engine } as unknown as Runtime;
  const plan = planServiceWorkspace({ ownerRef: "user-1", name: "Ada's workspace", approverPhone: "+14155550123", capUsd: 900 });
  await engine.provisionWorkspace(plan);
  return { rt, engine, plan };
}

describe("service credential", () => {
  it("the service token plus a workspace id selects that workspace", async () => {
    const { rt, plan } = await runtime();
    expect(await resolveWorkspace(rt, { serviceToken: SECRET, workspaceId: plan.id }, true, env)).toEqual({ ok: true, workspaceId: plan.id, authenticated: true });
  });

  it("a wrong, short or unset service token, a missing or unknown workspace, or a revoked one is refused", async () => {
    const { rt, engine, plan } = await runtime();
    expect(await resolveWorkspace(rt, { serviceToken: "svc_wrong_wrong_wrong_wrong_wrong_wrong", workspaceId: plan.id }, true, env)).toEqual({ ok: false, reason: "unknown_credentials" });
    expect(await resolveWorkspace(rt, { serviceToken: SECRET, workspaceId: plan.id }, true, {} as NodeJS.ProcessEnv)).toEqual({ ok: false, reason: "unknown_credentials" });
    expect(await resolveWorkspace(rt, { serviceToken: SECRET }, true, env)).toEqual({ ok: false, reason: "missing_credentials" });
    expect(await resolveWorkspace(rt, { serviceToken: SECRET, workspaceId: "ws_nobody" }, true, env)).toEqual({ ok: false, reason: "unknown_credentials" });
    await engine.revokeWorkspace(plan.id);
    expect(await resolveWorkspace(rt, { serviceToken: SECRET, workspaceId: plan.id }, true, env)).toEqual({ ok: false, reason: "unknown_credentials" });
    expect(serviceTokenValid("é".repeat(SECRET.length), env)).toBe(false); // non-ASCII never throws
    expect(serviceTokenValid("short", { HAGGLE_SERVICE_TOKEN: "short" } as NodeJS.ProcessEnv)).toBe(false); // too short to be enabled
  });

  it("onboarding: one workspace per owner (idempotent), settings applied, a shared approver refused", async () => {
    const { engine, plan } = await runtime();
    expect(plan.id).toMatch(/^ws_u_[a-f0-9]{24}$/);
    expect(planServiceWorkspace({ ownerRef: "user-1", name: "again" }).id).toBe(plan.id);
    expect(planServiceWorkspace({ ownerRef: "user-2", name: "x" }).id).not.toBe(plan.id);
    expect((await engine.provisionWorkspace(planServiceWorkspace({ ownerRef: "user-1", name: "again" }))).created).toBe(false);
    expect(await engine.forWorkspace(plan.id).getSettings()).toMatchObject({ spending_cap_cents: 90_000, approver_phone: "+14155550123" });
    await expect(engine.provisionWorkspace(planServiceWorkspace({ ownerRef: "user-2", name: "Bo", approverPhone: "+14155550123" }))).rejects.toMatchObject({ code: "approver_shared" });
    expect(() => planServiceWorkspace({ ownerRef: "u", name: "x", approverPhone: "415-555" })).toThrow(/E\.164/);
  });
});
