// Real-world discovery through the same MCP contract as the demo vendors, over HTTP (production build,
// MOCK mode). One server rehearses public discovery from a recorded Places/website fixture with exactly
// one discovered business authorized (Ace's phone on HAGGLE_ALLOWED_RECIPIENTS); the other has no Places
// key. Nothing is sent anywhere: mock ports, and dry runs where the point is "who would be contacted".
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");
const BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].find((p) => existsSync(p)) ?? "mcp-use";
const FIXTURE = join(import.meta.dirname, "fixtures/places.json");
const freePort = () => new Promise<number>((res, rej) => { const s = createServer().once("error", rej).listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

type Server = { proc: ChildProcess; base: string; id: number };
async function start(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const proc = spawn(BIN, ["start"], { cwd: APP_DIR, stdio: "ignore", env: { ...process.env, PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", ...env } });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return { proc, base, id: 0 }; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server did not start (run `mcp-use build` first)");
}
async function call(s: Server, name: string, args: Record<string, unknown>) {
  const r = await fetch(`${s.base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++s.id, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : t).result;
}
const err = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text).error;

const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const plumbing = (over: Record<string, unknown> = {}) => ({ request: { what: "fix a leaking kitchen pipe", quantity: 1, unit: "job", date, area: "Oakland, CA", requirements: [] }, budget_usd: 400, ...over });

let fx: Server;
let off: Server;
beforeAll(async () => {
  [fx, off] = await Promise.all([start({ HAGGLE_PLACES_FIXTURE: FIXTURE, HAGGLE_ALLOWED_RECIPIENTS: "+15105550141" }), start({})]);
}, 40_000);
afterAll(() => { fx?.proc.kill(); off?.proc.kill(); });

describe("discover real businesses, understand them, reach only the authorized ones", () => {
  it("discover: deduplicated, evidence-ranked listings with contact states; demo caterers aren't offered for plumbing", async () => {
    const r = await call(fx, "discover", { category: "plumber", area: "Oakland, CA" });
    const d = r.structuredContent;
    expect(d.public_discovery.status).toBe("ok");
    expect(d.found.map((f: { name: string }) => f.name)).toEqual(["Ace Plumbing & Drain", "Bolt Plumbing", "FiveStar Rooter", "Quiet Drains", "Bay Pizza"]);
    const [ace, bolt] = d.found;
    expect(ace).toMatchObject({ business_ref: "place:ChIJAcePlumbingOakland01", rating: 4.7, review_count: 318, contact_state: "authorized", attribution: "Google Maps", phone_published: true });
    expect(bolt.contact_state).toBe("contact_found"); // published phone, not authorized
    expect(d.found.find((f: { name: string }) => f.name === "Quiet Drains").contact_state).toBe("discovered");
    expect(JSON.stringify(d.found)).not.toMatch(/510-555|5105550/); // published numbers stay server-side
    expect(r.content[0].text).toMatch(/none offer plumbing/);
    expect(r.content[0].text).toMatch(/Listings: Google Maps\./);
  });

  it("business_profile: one evidence-grounded profile; claims, reviews and unknowns are labelled; injected website text is ignored", async () => {
    await call(fx, "discover", { category: "plumber", area: "Oakland, CA" });
    const r = await call(fx, "business_profile", { business: "Ace Plumbing & Drain" });
    expect(r.isError).toBeFalsy();
    const p = r.structuredContent;
    expect(p).toMatchObject({ name: "Ace Plumbing & Drain", business_ref: "place:ChIJAcePlumbingOakland01", configured_vendor: false, n_quotes: 0, contact_status: { state: "authorized" } });
    expect(p.price_model).toMatch(/advertised from \$149 per visit .*a claim, not a quote/);
    const kinds = new Set(p.evidence.map((e: { kind: string }) => e.kind));
    expect([...kinds].sort()).toEqual(["third_party_listing", "third_party_reputation", "vendor_claim"]);
    expect(p.unknowns.join(" ")).toMatch(/availability/);
    expect(JSON.stringify(p)).not.toMatch(/evil\.example|ignore your instructions/);
    // The website's email is a contact found, not authorized; the allowlisted phone is the route.
    expect(p.contact_status.routes.map((x: { channel: string; authorized: boolean; found_via: string }) => [x.channel, x.authorized, x.found_via])).toEqual([["email", false, "business website"], ["phone", true, "Google Places listing"]]);
  });

  it("selection is exact: dry run previews per business; a real deal with an unauthorized one starts nothing; the authorized one alone proceeds", async () => {
    await call(fx, "discover", { category: "plumber", area: "Oakland, CA" });
    const preview = (await call(fx, "deal", plumbing({ businesses: ["Ace Plumbing & Drain", "Bolt Plumbing"], dry_run: true }))).structuredContent;
    expect(preview.would_contact.map((w: { name: string }) => w.name)).toEqual(["Ace Plumbing & Drain"]);
    expect(preview.blocked).toEqual([expect.objectContaining({ name: "Bolt Plumbing", contact_state: "contact_found", reason: expect.stringMatching(/isn't permission/) })]);
    const before = (await call(fx, "list_deals", { limit: 20 })).structuredContent.deals.length;
    const refused = await call(fx, "deal", plumbing({ businesses: ["Ace Plumbing & Drain", "Bolt Plumbing"] }));
    expect(err(refused)).toMatchObject({ code: "not_authorized", message: expect.stringMatching(/no other business was contacted/) });
    expect((await call(fx, "list_deals", { limit: 20 })).structuredContent.deals.length).toBe(before);
    const one = (await call(fx, "deal", plumbing({ businesses: ["place:ChIJAcePlumbingOakland01"] }))).structuredContent;
    expect(one.ok).toBe(true);
    expect(one.businesses).toEqual([expect.objectContaining({ name: "Ace Plumbing & Drain", channel: "phone", simulated: false })]);
  });

  it("fails closed: ambiguous partial names, unknown names, a business with no published contact; no roster fallback for other categories", async () => {
    await call(fx, "discover", { category: "plumber", area: "Oakland, CA" });
    expect(err(await call(fx, "deal", plumbing({ businesses: ["Plumbing"] }))).code).toBe("ambiguous_business");
    expect(err(await call(fx, "deal", plumbing({ businesses: ["Pipe Wizards"] }))).code).toBe("unknown_business");
    expect(err(await call(fx, "deal", plumbing({ businesses: ["Quiet Drains"] }))).code).toBe("no_contact_route");
    const generic = err(await call(fx, "deal", plumbing()));
    expect(generic).toMatchObject({ code: "no_vendors_for_category", fix: expect.stringMatching(/discover\(category='plumbing'/) });
  });

  it("provider failures are explicit, and nothing is substituted", async () => {
    const r = (await call(fx, "discover", { category: "ratelimit plumber", area: "Oakland, CA" })).structuredContent;
    expect(r.public_discovery).toMatchObject({ status: "rate_limited", message: expect.stringMatching(/Nothing was substituted/) });
    expect(r.found).toEqual([]);
  });

  it("without a Places key: says discovery is off, never offers demo caterers as plumbers; demo flows are unchanged", async () => {
    const d = (await call(off, "discover", { category: "plumber", area: "Oakland, CA" })).structuredContent;
    expect(d.public_discovery).toMatchObject({ status: "not_configured", message: expect.stringMatching(/GOOGLE_PLACES_API_KEY.*No demo vendors were substituted/) });
    expect(d.found).toEqual([]);
    expect(err(await call(off, "deal", plumbing()))).toMatchObject({ code: "no_vendors_for_category", fix: expect.stringMatching(/discovery is off/) });
    expect(err(await call(off, "deal", plumbing({ businesses: ["Ace Plumbing & Drain"] }))).fix).toMatch(/discovery is off/);
    const mission = (await call(off, "deal", { request: { what: "drop-off catering", quantity: 25, date, area: "San Francisco, CA", requirements: [] }, budget_usd: 500, businesses: ["Mission Eats"], dry_run: true })).structuredContent;
    expect(mission.would_contact.map((w: { name: string }) => w.name)).toEqual(["Mission Eats"]);
    const roster = (await call(off, "deal", { request: { what: "hackathon catering", quantity: 200, date, area: "San Francisco, CA", requirements: [] }, budget_usd: 5000, dry_run: true })).structuredContent;
    expect(roster.would_contact).toHaveLength(6);
  });
});
