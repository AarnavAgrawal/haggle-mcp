// Self-serve vendors over HTTP against the production build (`mcp-use start`) in MOCK mode with auth
// required and a service token: add / list / remove, the public-listing consent rule, workspace
// isolation, the actor requirement, the daily limit, and that a deal then resolves the vendor by
// name (dry run). Suppression, the 100-vendor cap and live-only rules are in serviceVendors.test.ts.
// Run `mcp-use build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const MCP_USE_BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const p = (srv.address() as AddressInfo).port;
    srv.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const SERVICE = "svc-e2e-vendors-0123456789abcdef0123456789";
let proc: ChildProcess;
let id = 0;

async function svc(path: string, opts: { ws?: string; actor?: string; body?: unknown; token?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    // No content-type on a GET: the server rejects a JSON content-type without a body (400 "Invalid JSON").
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }), "x-haggle-service-token": opts.token ?? SERVICE,
      ...(opts.ws ? { "x-haggle-workspace": opts.ws } : {}), ...(opts.actor ? { "x-haggle-actor": opts.actor } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}
async function tool(ws: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "x-haggle-service-token": SERVICE, "x-haggle-workspace": ws },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text).result as { isError?: boolean; structuredContent?: any; content?: { text?: string }[] };
}
const provision = async (owner: string) => (await svc("/internal/workspaces", { body: { owner_ref: owner, name: owner } })).body.workspace_id as string;

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_AUTH: "required", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_SERVICE_TOKEN: SERVICE };
  proc = WIN ? spawn(`"${MCP_USE_BIN}"`, ["start"], { cwd: APP_DIR, env, stdio: "ignore", shell: true }) : spawn(MCP_USE_BIN, ["start"], { cwd: APP_DIR, env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start (run `mcp-use build` first)");
}, 30_000);
afterAll(() => {
  if (WIN && proc?.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc?.kill();
});

describe("/internal/vendors over HTTP (mock, service token)", () => {
  it("adds, lists and removes a vendor with its recorded consent; a deal resolves it by name", async () => {
    const ws = await provision("vendors-user-1");
    expect((await svc("/internal/vendors", { ws })).body).toMatchObject({ ok: true, mode: "mock", vendors: [] });
    const added = await svc("/internal/vendors", { ws, actor: "user-1", body: { name: "Plumb Right", contact: "Jobs@PlumbRight.test", consent_basis: "public_listing_email", note: "Address on their website" } });
    expect(added.status).toBe(201);
    expect(added.body.vendor).toMatchObject({ name: "Plumb Right", contact: "jobs@plumbright.test", channel: "email", added_by: "web:user-1" });
    expect(added.body.vendor.consent.text).toMatch(/^public_listing_email: Address on their website \(attested by web:user-1 at \d{4}-\d\d-\d\dT/);
    const phone = await svc("/internal/vendors", { ws, actor: "user-1", body: { name: "Plumb Right", contact: "+14155552161", channel: "phone", consent_basis: "business_agreed" } });
    expect(phone.status).toBe(201);

    const list = await svc("/internal/vendors", { ws });
    expect(list.body.vendors.map((v: any) => [v.contact, v.channel, v.consent.basis, v.contactable])).toEqual([
      ["jobs@plumbright.test", "email", "public_listing_email", true],
      ["+14155552161", "phone", "business_agreed", true],
    ]);

    const dry = await tool(ws, "deal", { request: { what: "fix a leaking kitchen sink", quantity: 1, date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco" }, businesses: ["Plumb Right"], dry_run: true });
    expect(dry.isError).not.toBe(true);
    expect(dry.structuredContent.would_contact.map((w: any) => w.name)).toEqual(["Plumb Right"]);

    expect((await svc("/internal/vendors/remove", { ws, actor: "user-1", body: { contact: "jobs@plumbright.test" } })).status).toBe(200);
    expect((await svc("/internal/vendors/remove", { ws, actor: "user-1", body: { contact: "jobs@plumbright.test" } })).status).toBe(404);
    expect((await svc("/internal/vendors", { ws })).body.vendors.map((v: any) => v.contact)).toEqual(["+14155552161"]);
  });

  it("a deal uses the workspace's vendors for that kind of work only, and refuses an unrelated one by name", async () => {
    const ws = await provision("vendors-user-category");
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const leak = { what: "fix a leaking kitchen sink", quantity: 1, date: soon, area: "San Francisco" };
    // A plumber added from a "plumber" search, a caterer, and one whose name says what it does.
    expect((await svc("/internal/vendors", { ws, actor: "u", body: { name: "Drain Pros", contact: "jobs@drainpros.test", consent_basis: "public_listing_email", category: "plumber" } })).body.vendor).toBeDefined();
    expect((await svc("/internal/vendors", { ws, actor: "u", body: { name: "Casa Lunch", contact: "orders@casalunch.test", consent_basis: "existing_relationship", category: "catering" } })).status).toBe(201);
    expect((await svc("/internal/vendors", { ws, actor: "u", body: { name: "Bay Plumbing Co", contact: "hi@bayplumbing.test", consent_basis: "existing_relationship" } })).status).toBe(201);
    expect((await svc("/internal/vendors", { ws, actor: "u", body: { name: "Acme Services", contact: "acme@acme.test", consent_basis: "existing_relationship" } })).status).toBe(201);
    const listed = (await svc("/internal/vendors", { ws })).body.vendors.map((v: any) => [v.name, v.category, v.category_set]);
    expect(listed).toEqual([["Drain Pros", "plumbing", true], ["Casa Lunch", "catering", true], ["Bay Plumbing Co", "plumbing", false], ["Acme Services", null, false]]);

    // No businesses named: the plumbers only (never the caterer, never the one whose kind is unknown).
    const dry = await tool(ws, "deal", { request: leak, dry_run: true });
    expect(dry.isError).not.toBe(true);
    expect(dry.structuredContent.would_contact.map((w: any) => w.name).sort()).toEqual(["Bay Plumbing Co", "Drain Pros"]);

    // Naming the caterer for a plumbing job sends nothing, even on a dry run.
    const wrong = await tool(ws, "deal", { request: leak, businesses: ["Casa Lunch"], dry_run: true });
    expect(wrong.isError).toBe(true);
    const err = JSON.parse(wrong.content![0]!.text!);
    expect(err).toMatchObject({ ok: false, error: { code: "vendor_unrelated" } });
    expect(err.error.message).toMatch(/Casa Lunch is listed as catering, not plumbing\. Nothing was sent\./);

    // The owner says what Acme does; then it is a plumber too. Clearing goes back to its name (unknown).
    expect((await svc("/internal/vendors/category", { ws, actor: "u", body: { contact: "acme@acme.test", category: "Plumbing" } })).body).toMatchObject({ ok: true, category: "plumbing" });
    expect((await tool(ws, "deal", { request: leak, dry_run: true })).structuredContent.would_contact.map((w: any) => w.name).sort()).toEqual(["Acme Services", "Bay Plumbing Co", "Drain Pros"]);
    expect((await svc("/internal/vendors/category", { ws, actor: "u", body: { contact: "acme@acme.test", category: null } })).body).toMatchObject({ ok: true, category: null });
    expect((await svc("/internal/vendors/category", { ws, actor: "u", body: { contact: "nobody@x.test", category: "plumbing" } })).status).toBe(404);
    expect((await svc("/internal/vendors/category", { ws, body: { contact: "acme@acme.test", category: "plumbing" } })).status).toBe(400);
  });

  it("takes a call to a business found in a public listing", async () => {
    const ws = await provision("vendors-user-2");
    const r = await svc("/internal/vendors", { ws, actor: "user-2", body: { name: "Listed Co", contact: "+14155552300", channel: "phone", consent_basis: "public_listing" } });
    expect(r.status).toBe(201);
    expect((await svc("/internal/vendors", { ws })).body.vendors).toEqual([expect.objectContaining({ name: "Listed Co", channel: "phone", consent: expect.objectContaining({ basis: "public_listing" }) })]);
  });

  it("another workspace can't see or remove them; credentials and the actor are required", async () => {
    const a = await provision("vendors-user-3");
    const b = await provision("vendors-user-4");
    expect((await svc("/internal/vendors", { ws: a, actor: "user-3", body: { name: "Casa Lunch", contact: "orders@casalunch.test", consent_basis: "business_agreed" } })).status).toBe(201);
    expect((await svc("/internal/vendors", { ws: b })).body.vendors).toEqual([]);
    expect((await svc("/internal/vendors/remove", { ws: b, actor: "user-4", body: { contact: "orders@casalunch.test" } })).status).toBe(404);
    expect((await svc("/internal/vendors", { ws: a })).body.vendors).toHaveLength(1);

    expect((await svc("/internal/vendors", { ws: a, actor: "x", body: { name: "Y", contact: "y@y.test", consent_basis: "business_agreed" }, token: "svc-wrong-0123456789abcdef0123456789abcdef" })).status).toBe(401);
    expect((await svc("/internal/vendors", { ws: "ws_u_ffffffffffffffffffffffff" })).status).toBe(401);
    expect((await svc("/internal/vendors", {})).status).toBe(401);
    const noActor = await svc("/internal/vendors", { ws: a, body: { name: "Y", contact: "y@y.test", consent_basis: "business_agreed" } });
    expect(noActor.status).toBe(400);
    expect(noActor.body.error.code).toBe("ACTOR_REQUIRED");
  });

  it("allows 25 additions per workspace per day", async () => {
    const ws = await provision("vendors-user-5");
    for (let i = 0; i < 25; i++) expect((await svc("/internal/vendors", { ws, actor: "u5", body: { name: `V${i}`, contact: `v${i}@vendors.test`, consent_basis: "business_agreed" } })).status).toBe(201);
    const over = await svc("/internal/vendors", { ws, actor: "u5", body: { name: "V25", contact: "v25@vendors.test", consent_basis: "business_agreed" } });
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("DAILY_LIMIT");
    expect((await svc("/internal/vendors", { ws })).body.limits).toMatchObject({ added_today: 25, adds_per_day: 25, max_vendors: 100 });
  });
});
