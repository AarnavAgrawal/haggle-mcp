// Haggle finds the businesses itself, over HTTP against the production build (`mcp-use start`) in MOCK
// mode with a recorded listing fixture (HAGGLE_PLACES_FIXTURE), auth required and a service token. A
// workspace with no vendors asks for a plumber: the preview lists the businesses found, each on the
// channel that reaches it, and sends nothing; a real deal without the user's yes sends nothing; a ref the
// preview never listed is refused; the user's yes (confirm_discovered) saves exactly those as vendors in
// the request's category, recording who confirmed, and contacts only them.
// Run `mcp-use build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const MCP_USE_BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const FIXTURE = join(import.meta.dirname, "fixtures/places.json");
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const p = (srv.address() as AddressInfo).port;
    srv.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const SERVICE = "svc-e2e-found-0123456789abcdef0123456789ab";
let proc: ChildProcess;
let id = 0;

async function svc(path: string, opts: { ws?: string; body?: unknown; actor?: string } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    headers: { ...(opts.body === undefined ? {} : { "content-type": "application/json" }), "x-haggle-service-token": SERVICE, ...(opts.ws ? { "x-haggle-workspace": opts.ws } : {}), ...(opts.actor ? { "x-haggle-actor": opts.actor } : {}) },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return (await res.json()) as any;
}
async function tool(ws: string, name: string, args: Record<string, unknown>, actor?: string) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18",
      "x-haggle-service-token": SERVICE, "x-haggle-workspace": ws, ...(actor ? { "x-haggle-actor": actor } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : text).result as { isError?: boolean; structuredContent?: any; content: { text: string }[] };
}
const err = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text).error;
const provision = async (owner: string, area?: string) => (await svc("/internal/workspaces", { body: { owner_ref: owner, name: owner, ...(area ? { area } : {}) } })).workspace_id as string;

const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const plumbing = (over: Record<string, unknown> = {}) => ({ request: { what: "fix a leaking pipe under the kitchen sink", date, area: "Oakland, CA" }, budget_usd: 400, ...over });
const ACE = "place:ChIJAcePlumbingOakland01";
const BOLT = "place:ChIJBoltPlumbingOakland02";
const FIVESTAR = "place:ChIJFiveStarRooterOak03";

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_AUTH: "required", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_SERVICE_TOKEN: SERVICE, HAGGLE_PLACES_FIXTURE: FIXTURE };
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

describe("deal finds the businesses itself (no vendors yet)", () => {
  it("a dry run previews the found businesses on the channel that reaches each, and sends nothing", async () => {
    const ws = await provision("found-user-1");
    const r = await tool(ws, "deal", plumbing({ dry_run: true }));
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent;
    expect(d).toMatchObject({ ok: true, job: null, dry_run: true, discovery: { status: "ok", found: 3 } });
    expect(d.would_contact.map((w: any) => [w.name, w.channel, w.contact_state])).toEqual([
      ["Ace Plumbing & Drain", "email", "will_authorize_on_start"],
      ["Bolt Plumbing", "email", "will_authorize_on_start"],
      ["FiveStar Rooter", "phone", "will_authorize_on_start"],
    ]);
    expect(d.would_contact[0]).toMatchObject({ business_ref: ACE, found_via: { listing: "Google Places", ref: ACE, email_from: "website" } });
    // A listing with no contact can't be reached, and published contacts stay server-side.
    expect(JSON.stringify(d.would_contact)).not.toMatch(/Quiet Drains|Bay Pizza/);
    expect(JSON.stringify(d)).not.toMatch(/510-555|5105550|@/);
    expect(d.next).toMatch(/confirm_discovered: \['place:ChIJAcePlumbingOakland01', 'place:ChIJBoltPlumbingOakland02', 'place:ChIJFiveStarRooterOak03'\]/);
    expect(r.content[0]!.text).toMatch(/^\[DEMO\] DRY RUN \(nothing sent\)/);
    expect((await svc("/internal/vendors", { ws })).vendors).toEqual([]);
    expect((await tool(ws, "list_deals", {})).structuredContent.deals).toEqual([]);
  });

  it("a real deal without the user's yes previews them and sends nothing", async () => {
    const ws = await provision("found-user-2");
    const r = await tool(ws, "deal", plumbing());
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ job: null, needs_confirmation: true, would_contact: [{ business_ref: ACE }, { business_ref: BOLT }, { business_ref: FIVESTAR }] });
    expect(r.content[0]!.text).toMatch(/NEEDS THE USER'S YES \(nothing sent\)/);
    expect((await svc("/internal/vendors", { ws })).vendors).toEqual([]);
    expect((await tool(ws, "list_deals", {})).structuredContent.deals).toEqual([]);
  });

  it("refuses a ref the preview never listed, and confirm_discovered with named businesses", async () => {
    const ws = await provision("found-user-3");
    const bad = await tool(ws, "deal", plumbing({ confirm_discovered: [ACE, "place:ChIJNoContactDrains0007"] }), "user-3");
    expect(bad.isError).toBe(true);
    expect(err(bad)).toMatchObject({ code: "unconfirmed_business", message: expect.stringMatching(/ChIJNoContactDrains0007.*Nothing was sent/) });
    const named = await tool(ws, "deal", plumbing({ businesses: ["Bolt Plumbing"], confirm_discovered: [BOLT] }), "user-3");
    expect(err(named).code).toBe("confirm_without_discovery");
    expect((await svc("/internal/vendors", { ws })).vendors).toEqual([]);
    expect((await tool(ws, "list_deals", {})).structuredContent.deals).toEqual([]);
  });

  it("the user's yes saves exactly the kept businesses (public_listing_email, plumbing, who confirmed) and emails only them", async () => {
    const ws = await provision("found-user-4");
    // The user removed Bolt on the preview card.
    const r = await tool(ws, "deal", plumbing({ confirm_discovered: [ACE] }), "ana@example.com (u4)");
    expect(r.isError).toBeFalsy();
    const d = r.structuredContent;
    expect(d.job_id).toMatch(/^job_/);
    expect(d.contacted.map((c: any) => [c.business, c.channel])).toEqual([["Ace Plumbing & Drain", "email"]]);
    const vendors = (await svc("/internal/vendors", { ws })).vendors;
    expect(vendors).toHaveLength(1);
    expect(vendors[0]).toMatchObject({ name: "Ace Plumbing & Drain", contact: "jobs@aceplumbing.example", channel: "email", category: "plumbing", category_set: true, consent: { basis: "public_listing_email" }, added_by: "web:ana@example.com (u4)" });
    expect(vendors[0].consent.text).toMatch(/^public_listing_email: email published on its website, found via its Google Places listing place:ChIJAcePlumbingOakland01; confirmed on the deal preview \(attested by web:ana@example\.com \(u4\) at /);
    // The user kept only Ace: nobody else was contacted.
    const board = (await tool(ws, "get_quotes", { job_id: d.job_id })).structuredContent;
    expect(board.businesses.map((b: any) => [b.name, b.channel])).toEqual([["Ace Plumbing & Drain", "email"]]);

    // The next plumbing deal uses the saved business and looks for more (fewer than 3 saved); a retry of the same yes is fine.
    const again = await tool(ws, "deal", plumbing({ dry_run: true }));
    expect(again.structuredContent.would_contact.map((w: any) => [w.name, w.contact_state])).toEqual([["Ace Plumbing & Drain", "authorized"], ["Bolt Plumbing", "will_authorize_on_start"], ["FiveStar Rooter", "will_authorize_on_start"]]);
    const retry = await tool(ws, "deal", plumbing({ dry_run: true, confirm_discovered: [ACE] }));
    expect(retry.isError).toBeFalsy();
  });

  it("the user's yes calls a business that publishes only a phone number, recording where the number came from", async () => {
    const ws = await provision("found-user-9");
    const r = await tool(ws, "deal", plumbing({ confirm_discovered: [FIVESTAR] }), "ana@example.com (u9)");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.contacted.map((c: any) => [c.business, c.channel])).toEqual([["FiveStar Rooter", "phone"]]);
    const [v] = (await svc("/internal/vendors", { ws })).vendors;
    expect(v).toMatchObject({ name: "FiveStar Rooter", channel: "phone", category: "plumbing", consent: { basis: "public_listing" } });
    expect(v.consent.text).toMatch(/^public_listing: phone published on its Google Places listing place:ChIJFiveStarRooterOak03/);
  });

  it("naming a found business that is already saved contacts it without touching the saved record", async () => {
    const ws = await provision("found-user-10");
    await svc("/internal/vendors", { ws, actor: "u10", body: { name: "My Plumber", contact: "jobs@aceplumbing.example", consent_basis: "business_agreed", note: "Owner said yes", category: "plumbing" } });
    await tool(ws, "discover", { category: "plumber", area: "Oakland, CA" });
    const r = await tool(ws, "deal", plumbing({ businesses: ["Ace Plumbing & Drain"] }), "u10");
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.contacted.map((c: any) => [c.business, c.channel])).toEqual([["My Plumber", "email"]]);
    expect((await svc("/internal/vendors", { ws })).vendors).toEqual([expect.objectContaining({ name: "My Plumber", consent: expect.objectContaining({ basis: "business_agreed" }) })]);
  });

  it("an MCP client's yes is recorded as the agent acting on the user's yes", async () => {
    const ws = await provision("found-user-5");
    const r = await tool(ws, "deal", plumbing({ confirm_discovered: [BOLT] }));
    expect(r.isError).toBeFalsy();
    const [v] = (await svc("/internal/vendors", { ws })).vendors;
    expect(v).toMatchObject({ name: "Bolt Plumbing", added_by: expect.stringMatching(/^agent:.+ on the user's yes$/), consent: { basis: "public_listing_email" } });
  });

  it("without an area or a default area it asks where (nothing sent); the default area is used when set", async () => {
    const ws = await provision("found-user-6");
    const noArea = await tool(ws, "deal", { request: { what: "fix a leaking pipe under the kitchen sink", date, details: [{ label: "Address", value: "my apartment" }] }, dry_run: true });
    expect(noArea.structuredContent).toMatchObject({ ok: false, job: null, needs_info: { missing: [{ key: "where", field: "area" }] } });
    const ws2 = await provision("found-user-7", "Oakland, CA");
    const withDefault = await tool(ws2, "deal", { request: { what: "fix a leaking pipe under the kitchen sink", date, details: [{ label: "Address", value: "my apartment" }] }, dry_run: true });
    expect(withDefault.structuredContent.would_contact.map((w: any) => w.business_ref)).toEqual([ACE, BOLT, FIVESTAR]);
  });

  it("when nothing can be found it says why and keeps the dead end (nothing nearby)", async () => {
    const ws = await provision("found-user-8");
    const r = await tool(ws, "deal", { request: { what: "an electrician to fix the wiring in my kitchen", date, area: "Oakland, CA" }, dry_run: true });
    expect(r.isError).toBe(true);
    expect(err(r)).toMatchObject({ code: "no_vendors_for_category", message: expect.stringMatching(/found none it can reach: no electrical businesses were found near Oakland, CA\. Nothing was sent/) });
  });
});
