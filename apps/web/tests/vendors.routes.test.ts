// The /api/vendors* route logic (lib/vendors/route.ts) with fake auth and a fake MCP server: JSON
// 401/403, form validation before anything is sent, the attesting actor passed on, guests refused on a
// live site, server refusals passed through with their fix, rate limits, and discover mapped safely.
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../lib/approval/route.ts";
import { HaggleError } from "../lib/haggle.ts";
import { handleAdd, handleDiscover, handleList, handleRemove, type VendorCaller, type VendorDeps } from "../lib/vendors/route.ts";

const CALLER: VendorCaller = { userId: "u1", workspaceId: "ws_u_1", actor: "ada@example.com (u1)", guest: false };
const req = (body: unknown) => new Request("http://x/api/vendors", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

function deps(over: Partial<VendorDeps> = {}) {
  const calls: { path: string; opts: { workspaceId: string; actor?: string; body?: unknown } }[] = [];
  const d: VendorDeps = {
    auth: async () => CALLER,
    service: async <T,>(path: string, opts: { workspaceId: string; actor?: string; body?: unknown }) => {
      calls.push({ path, opts });
      return { ok: true, path } as T;
    },
    discover: async () => ({ mode: "mock", public_discovery: { status: "ok", message: "1 found" }, found: [{ name: "Casa Lunch", business_ref: "gp_1", website: "javascript:x", phone_published: false, contact_state: "discovered", contact_summary: "" }] }),
    demo: false,
    writeLimiter: new RateLimiter(100), discoverLimiter: new RateLimiter(100),
    ...over,
  };
  return { d, calls };
}
const add = { name: "Casa Lunch", contact: "Orders@CasaLunch.com", consent_basis: "public_listing_email", attested: true };

describe("/api/vendors", () => {
  it("answers 401 / 403 as JSON, never a redirect", async () => {
    const out = await handleList(deps({ auth: async () => ({ status: 401 }) }).d);
    expect(out.status).toBe(401);
    expect(await out.json()).toMatchObject({ ok: false, error: { code: "signed_out" } });
    expect((await handleAdd(req(add), deps({ auth: async () => ({ status: 403 }) }).d)).status).toBe(403);
    expect((await handleRemove(req({ contact: "a@b.co" }), deps({ auth: async () => ({ status: 401 }) }).d)).status).toBe(401);
    expect((await handleDiscover(req({ category: "plumber" }), deps({ auth: async () => ({ status: 403 }) }).d)).status).toBe(403);
  });

  it("lists through the service route as the user's workspace", async () => {
    const { d, calls } = deps();
    const out = await handleList(d);
    expect(out.status).toBe(200);
    expect(calls).toEqual([{ path: "/internal/vendors", opts: { workspaceId: "ws_u_1" } }]);
  });

  it("validates the form before anything is sent, then adds with the attesting actor", async () => {
    const bad = deps();
    const r = await handleAdd(req({ ...add, contact: "+14155550199" }), bad.d);
    expect(r.status).toBe(400);
    expect(await r.json()).toMatchObject({ error: { code: "invalid_form" }, fields: { consent_basis: expect.stringMatching(/never called or texted/) } });
    expect((await handleAdd(req({ ...add, attested: false }), bad.d)).status).toBe(400);
    expect((await handleAdd(req("not json"), bad.d)).status).toBe(400);
    expect(bad.calls).toEqual([]);

    const { d, calls } = deps();
    const ok = await handleAdd(req(add), d);
    expect(ok.status).toBe(201);
    expect(calls).toEqual([{ path: "/internal/vendors", opts: { workspaceId: "ws_u_1", actor: "ada@example.com (u1)", body: { name: "Casa Lunch", contact: "orders@casalunch.com", channel: "email", consent_basis: "public_listing_email" } } }]);
  });

  it("refuses guests on a live site, allows them on a demo site", async () => {
    const guest = { ...CALLER, guest: true };
    const live = await handleAdd(req(add), deps({ auth: async () => guest }).d);
    expect(live.status).toBe(403);
    expect(await live.json()).toMatchObject({ error: { code: "guest_account" } });
    expect((await handleAdd(req(add), deps({ auth: async () => guest, demo: true }).d)).status).toBe(201);
  });

  it("passes the server's refusal through with its fix; transport and credential trouble is 502", async () => {
    const refusing = (e: unknown) => deps({ service: async () => { throw e; } }).d;
    const sup = await handleAdd(req(add), refusing(new HaggleError("CONTACT_SUPPRESSED", "orders@casalunch.com asked not to be contacted by Haggle.", "Choose another business.", null, 422)));
    expect(sup.status).toBe(422);
    expect(await sup.json()).toEqual({ ok: false, error: { code: "CONTACT_SUPPRESSED", message: "orders@casalunch.com asked not to be contacted by Haggle.", fix: "Choose another business." } });
    expect((await handleAdd(req(add), refusing(new HaggleError("DAILY_LIMIT", "limit", "tomorrow", null, 429)))).status).toBe(429);
    expect((await handleAdd(req(add), refusing(new HaggleError("VENDOR_LIMIT", "full", "remove some", null, 409)))).status).toBe(409);
    expect((await handleList(refusing(new HaggleError("UNAUTHORIZED", "bad token", "fix", null, 401)))).status).toBe(502);
    expect((await handleList(refusing(new HaggleError("HTTP_503", "down", "", null, 503)))).status).toBe(502);
    expect((await handleList(refusing(new TypeError("fetch failed")))).status).toBe(502);
  });

  it("removes by contact, and rate-limits changes per user", async () => {
    const { d, calls } = deps({ writeLimiter: new RateLimiter(1) });
    expect((await handleRemove(req({ contact: " orders@casalunch.com " }), d)).status).toBe(200);
    expect(calls[0]).toEqual({ path: "/internal/vendors/remove", opts: { workspaceId: "ws_u_1", actor: "ada@example.com (u1)", body: { contact: "orders@casalunch.com" } } });
    const limited = await handleRemove(req({ contact: "orders@casalunch.com" }), d);
    expect(limited.status).toBe(429);
    expect((await handleRemove(req({}), deps().d)).status).toBe(400);
  });

  it("discover: validates, calls the tool as the workspace, drops unsafe links", async () => {
    let args: unknown = null;
    const { d } = deps({ discover: async (ws, a) => { args = { ws, ...a }; return { mode: "mock", public_discovery: { status: "ok", message: "1 found" }, found: [{ name: "Casa Lunch", business_ref: "gp_1", website: "javascript:x", phone_published: false, contact_state: "discovered", contact_summary: "" }] }; } });
    expect((await handleDiscover(req({ category: "x" }), d)).status).toBe(400);
    const out = await handleDiscover(req({ category: " caterer ", area: "" }), d);
    expect(out.status).toBe(200);
    expect(args).toEqual({ ws: "ws_u_1", category: "caterer", count: 8 });
    const body = await out.json();
    expect(body.found[0]).not.toHaveProperty("website");
    const once = deps({ discoverLimiter: new RateLimiter(1) }).d;
    expect((await handleDiscover(req({ category: "caterer" }), once)).status).toBe(200);
    expect((await handleDiscover(req({ category: "caterer" }), once)).status).toBe(429);
  });
});
