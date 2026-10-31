// The /api/settings route logic (lib/settings/route.ts) and the form (lib/settings/form.ts) with fake
// auth and a fake MCP server: JSON 401/403, guests and non-owners refused, same-origin writes only,
// validation before anything is sent, only the changed fields passed on with the actor, the pending
// verification state passed through, the code confirmation, server refusals with their fix, rate limits.
import { describe, expect, it } from "vitest";
import { HaggleError } from "../lib/haggle.ts";
import { memoryLimiter } from "../lib/rateLimit.ts";
import { normalizePhone, validateSettingsForm } from "../lib/settings/form.ts";
import { handleCancel, handleConfirm, handleGet, handleSave, type SettingsCaller, type SettingsDeps } from "../lib/settings/route.ts";

const OWNER: SettingsCaller = { userId: "u1", workspaceId: "ws_u_1", actor: "ada@example.com (u1)", guest: false, owner: true };
const req = (path: string, body: unknown, headers: Record<string, string> = { origin: "https://app.haggle.test", host: "app.haggle.test" }) =>
  new Request(`https://app.haggle.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

const SETTINGS = { name: "Acme", timezone: "America/Los_Angeles", sender_name: null, default_area: null, default_deal_limit_usd: 1500, ceiling_usd: 5000, approver: { phone: "+1 ••• ••• 0101", email: null }, pending: [] };

function deps(over: Partial<SettingsDeps> = {}, answer: (path: string, body: unknown) => unknown = (path) => ({ ok: true, path, settings: SETTINGS, mode: "mock" })) {
  const calls: { path: string; opts: { workspaceId: string; actor?: string; body?: unknown } }[] = [];
  const d: SettingsDeps = {
    auth: async () => OWNER,
    service: async <T,>(path: string, opts: { workspaceId: string; actor?: string; body?: unknown }) => {
      calls.push({ path, opts });
      return answer(path, opts.body) as T;
    },
    limiter: memoryLimiter(100, 60_000),
    ...over,
  };
  return { d, calls };
}

describe("/api/settings", () => {
  it("answers 401 / 403 as JSON; guests and members who aren't the owner can't change settings", async () => {
    expect((await handleGet(deps({ auth: async () => ({ status: 401 }) }).d)).status).toBe(401);
    expect((await handleSave(req("/api/settings", { name: "X" }), deps({ auth: async () => ({ status: 403 }) }).d)).status).toBe(403);

    const guest = deps({ auth: async () => ({ ...OWNER, guest: true }) });
    const g = await handleSave(req("/api/settings", { name: "X" }), guest.d);
    expect(g.status).toBe(403);
    expect(await g.json()).toMatchObject({ ok: false, error: { code: "guest_account" } });
    expect((await handleConfirm(req("/api/settings/confirm", { kind: "phone", code: "123456" }), guest.d)).status).toBe(403);
    expect(guest.calls).toEqual([]);

    const member = deps({ auth: async () => ({ ...OWNER, owner: false }) });
    const m = await handleSave(req("/api/settings", { name: "X" }), member.d);
    expect(m.status).toBe(403);
    expect(await m.json()).toMatchObject({ error: { code: "not_owner" } });
    // A member may still read (approver contacts are masked by the server).
    const read = await handleGet(member.d);
    expect(await read.json()).toMatchObject({ ok: true, can_edit: false, settings: { name: "Acme" } });
  });

  it("refuses a cross-site write before anything else", async () => {
    const { d, calls } = deps();
    const r = await handleSave(req("/api/settings", { name: "X" }, { origin: "https://evil.test", host: "app.haggle.test" }), d);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ error: { code: "cross_site" } });
    expect(calls).toEqual([]);
  });

  it("validates the form before anything is sent, then sends only the fields given, with the actor", async () => {
    const bad = deps();
    const r = await handleSave(req("/api/settings", { approver_phone: "555-01", default_deal_limit_usd: "-3", timezone: "Mars/Olympus" }), bad.d);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: "invalid_form" }, fields: { approver_phone: expect.any(String), default_deal_limit_usd: expect.any(String), timezone: expect.any(String) } });
    expect((await handleSave(req("/api/settings", "not json"), bad.d)).status).toBe(400);
    expect((await handleSave(req("/api/settings", {}), bad.d)).status).toBe(400);
    expect((await handleSave(req("/api/settings", { workspace_id: "ws_other" }), bad.d)).status).toBe(400);
    expect(bad.calls).toEqual([]);

    const { d, calls } = deps();
    const ok = await handleSave(req("/api/settings", { name: " Acme  Labs ", default_deal_limit_usd: "$2,500", sender_name: "", default_area: "Oakland, CA" }), d);
    expect(ok.status).toBe(200);
    expect(calls).toEqual([{ path: "/internal/workspaces/settings", opts: { workspaceId: "ws_u_1", actor: "ada@example.com (u1)", body: { name: "Acme Labs", default_deal_limit_usd: 2500, sender_name: null, default_area: "Oakland, CA" } } }]);
  });

  it("a new approver goes out with the confirm link's page and comes back pending verification", async () => {
    const pending = { kind: "phone", to: "+1 ••• ••• 0177", expires_at: "2026-10-31T17:15:00Z", attempts_left: 5 };
    const { d, calls } = deps({}, () => ({ ok: true, mode: "mock", settings: { ...SETTINGS, pending: [pending] }, changed: [], pending_verification: ["phone"], demo_codes: [{ kind: "phone", code: "123456" }], next: "Enter the code" }));
    const r = await handleSave(req("/api/settings", { approver_phone: "(415) 555-0177" }), d);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ pending_verification: ["phone"], settings: { pending: [pending], approver: { phone: "+1 ••• ••• 0101" } } });
    expect(calls[0]!.opts.body).toEqual({ approver_phone: "+14155550177", confirm_url: "https://app.haggle.test/settings" });
  });

  it("confirms with the code or the link's token, and passes a wrong code's refusal through", async () => {
    const { d, calls } = deps();
    expect((await handleConfirm(req("/api/settings/confirm", { kind: "phone", code: "12" }), d)).status).toBe(400);
    expect((await handleConfirm(req("/api/settings/confirm", { kind: "fax", code: "123456" }), d)).status).toBe(400);
    expect(calls).toEqual([]);
    expect((await handleConfirm(req("/api/settings/confirm", { kind: "phone", code: "123 456" }), d)).status).toBe(200);
    expect((await handleConfirm(req("/api/settings/confirm", { token: "a".repeat(43) }), d)).status).toBe(200);
    expect(calls.map((c) => [c.path, c.opts.body])).toEqual([
      ["/internal/workspaces/settings/confirm", { kind: "phone", code: "123 456" }],
      ["/internal/workspaces/settings/confirm", { token: "a".repeat(43) }],
    ]);

    const wrong = deps({ service: async () => { throw new HaggleError("wrong_code", "That code isn't right (4 tries left).", "Enter the 6-digit code.", null, 422); } });
    const w = await handleConfirm(req("/api/settings/confirm", { kind: "phone", code: "000000" }), wrong.d);
    expect(w.status).toBe(422);
    expect(await w.json()).toMatchObject({ error: { code: "wrong_code", fix: "Enter the 6-digit code." } });

    const c = deps();
    expect((await handleCancel(req("/api/settings/cancel", { kind: "email" }), c.d)).status).toBe(200);
    expect(c.calls[0]).toMatchObject({ path: "/internal/workspaces/settings/cancel", opts: { actor: "ada@example.com (u1)", body: { kind: "email" } } });
  });

  it("passes the server's refusal through with its fix; transport trouble is 502", async () => {
    const ceiling = deps({ service: async () => { throw new HaggleError("cap_above_ceiling", "The spending cap can't exceed $5,000.00 on this server.", "Pick a lower cap.", null, 400); } });
    const r = await handleSave(req("/api/settings", { default_deal_limit_usd: 9000 }), ceiling.d);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: "cap_above_ceiling", fix: "Pick a lower cap." } });
    const down = deps({ service: async () => { throw new Error("ECONNREFUSED"); } });
    expect((await handleSave(req("/api/settings", { name: "X" }), down.d)).status).toBe(502);
  });

  it("limits changes and code attempts per user", async () => {
    const { d } = deps({ limiter: memoryLimiter(2, 60_000) });
    expect((await handleSave(req("/api/settings", { name: "A" }), d)).status).toBe(200);
    expect((await handleConfirm(req("/api/settings/confirm", { kind: "phone", code: "123456" }), d)).status).toBe(200);
    const limited = await handleConfirm(req("/api/settings/confirm", { kind: "phone", code: "123456" }), d);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: "rate_limited" } });
  });
});

describe("settings form", () => {
  it("normalizes and checks each field it is given", () => {
    expect(normalizePhone("(415) 555-0123")).toBe("+14155550123");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(validateSettingsForm({ approver_email: " Ops@Acme.COM " })).toEqual({ ok: true, value: { approver_email: "ops@acme.com" } });
    expect(validateSettingsForm({ approver_phone: "" })).toEqual({ ok: true, value: { approver_phone: null } });
    expect(validateSettingsForm({ name: "" })).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    expect(validateSettingsForm({ sender_name: "x".repeat(81) })).toMatchObject({ ok: false, errors: { sender_name: expect.any(String) } });
    expect(validateSettingsForm({ default_deal_limit_usd: "1000001" })).toMatchObject({ ok: false, errors: { default_deal_limit_usd: expect.any(String) } });
    expect(validateSettingsForm({ default_area: "X" })).toMatchObject({ ok: false, errors: { default_area: expect.any(String) } });
  });
});
