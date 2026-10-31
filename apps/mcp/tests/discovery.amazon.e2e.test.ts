// Public discovery from Amazon Location Service, through the same MCP contract (production build, MOCK
// mode), rehearsed from a recorded fixture in Amazon's wire format (tests/fixtures/amazon-places.json):
// no ratings or Maps links, emails from the listing and the website, opening hours (listing first,
// website as the fallback) and a found business put on a deal carrying its hours, so its call waits
// until it is open. Exactly one business is authorized (Ace's phone on HAGGLE_ALLOWED_RECIPIENTS).
// Nothing is sent anywhere: mock ports only.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contactableAt, type WeeklyHours } from "@haggle/engine";

const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const startServer = (env: NodeJS.ProcessEnv): ChildProcess =>
  WIN ? spawn(`"${BIN}"`, ["start"], { cwd: APP_DIR, stdio: "ignore", env, shell: true }) : spawn(BIN, ["start"], { cwd: APP_DIR, stdio: "ignore", env });
const stopServer = (proc: ChildProcess | undefined): void => {
  if (WIN && proc?.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc?.kill();
};
const FIXTURE = join(import.meta.dirname, "fixtures/amazon-places.json");
const freePort = () => new Promise<number>((res, rej) => { const s = createServer().once("error", rej).listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

type Server = { proc: ChildProcess; base: string; id: number };
async function start(env: Record<string, string>): Promise<Server> {
  const port = await freePort();
  const proc = startServer({ ...process.env, PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", ...env });
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

const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const plumbing = (over: Record<string, unknown> = {}) => ({ request: { what: "fix a leaking kitchen pipe", quantity: 1, unit: "job", date, area: "Oakland, CA", requirements: [] }, budget_usd: 400, ...over });
const ACE_REF = "aws:AQAAAEFjZVBsdW1iaW5nT2FrbGFuZDAx";
// Ace's listed hours (the plumbing entry, not the coffee shop's in the same building).
const ACE_HOURS: WeeklyHours = { timezone: "America/Los_Angeles", intervals: [1, 2, 3, 4, 5].map((day) => ({ day, startMinute: 480, endMinute: 1020 })).concat([{ day: 6, startMinute: 540, endMinute: 780 }]), display: [], source: "Amazon Location Service" };

let fx: Server;
beforeAll(async () => { fx = await start({ HAGGLE_PLACES_FIXTURE: FIXTURE, HAGGLE_ALLOWED_RECIPIENTS: "+15105550141" }); }, 40_000);
afterAll(() => stopServer(fx?.proc));

describe("Amazon Location discovery: contacts, hours and contact timing", () => {
  it("discover: ranked without ratings; published emails (listing first); today's hours; the provider's attribution", async () => {
    const r = await call(fx, "discover", { category: "plumber", area: "Oakland, CA" });
    const d = r.structuredContent;
    expect(d.public_discovery).toMatchObject({ status: "ok", message: expect.stringMatching(/in Amazon Location Service listings/) });
    expect(d.found.map((f: { name: string }) => f.name)).toEqual(["Ace Plumbing & Drain", "Night Owl Rooter", "Bolt Plumbing", "Quiet Drains", "Bay Pizza"]);
    const by = (n: string) => d.found.find((f: { name: string }) => f.name === n);
    const ace = by("Ace Plumbing & Drain");
    expect(ace).toMatchObject({ business_ref: ACE_REF, contact_state: "authorized", attribution: "Amazon Location Service (data © HERE)", phone_published: true, published_emails: ["jobs@aceplumbing.example"] });
    expect(ace).not.toHaveProperty("rating");
    expect(ace).not.toHaveProperty("maps_url");
    expect(ace.hours).toEqual({ display: ["Mon-Fri: 08:00 - 17:00", "Sat: 09:00 - 13:00"], source: "Amazon Location Service", timezone: "America/Los_Angeles" });
    expect(ace.hours_today).toMatch(/^(Open today (8am–5pm|9am–1pm)|Closed today)$/);
    // Bolt: the listing's email first, then its website's; hours from its website (schema.org), in the listing's timezone.
    expect(by("Bolt Plumbing")).toMatchObject({ published_emails: ["dispatch@boltplumbing.example", "office@boltplumbing.example"], contact_state: "contact_found", hours: { source: "business website", timezone: "America/Los_Angeles" } });
    expect(by("Night Owl Rooter").hours_today).toMatch(/^Open today 6pm–4am$/);
    expect(by("Quiet Drains")).not.toHaveProperty("hours_today");
    expect(JSON.stringify(d.found)).not.toMatch(/510-555|5105550/); // published numbers stay server-side
    expect(r.content[0].text).toMatch(/Listings: Amazon Location Service \(data © HERE\)\./);
  });

  it("business_profile: listing evidence with hours, the listing's routes, no reviews claimed", async () => {
    await call(fx, "discover", { category: "plumber", area: "Oakland, CA" });
    const p = (await call(fx, "business_profile", { business: "Bolt Plumbing" })).structuredContent;
    expect(p).toMatchObject({ business_ref: "aws:AQAAAEJvbHRQbHVtYmluZ09ha2xhbmQy", public_listing: { source: "Amazon Location Service", attribution: "Amazon Location Service (data © HERE)" } });
    expect(p.evidence.some((e: { kind: string }) => e.kind === "third_party_reputation")).toBe(false);
    expect(p.evidence.map((e: { statement: string }) => e.statement)).toEqual(expect.arrayContaining(["Publishes email dispatch@boltplumbing.example", expect.stringMatching(/^Opening hours: Mon 07:00–19:00/)]));
    expect(p.contact_status.routes.map((x: { channel: string; found_via: string }) => [x.channel, x.found_via])).toEqual([
      ["email", "Amazon Location Service listing"], ["email", "business website"], ["phone", "Amazon Location Service listing"],
    ]);
  });

  it("a found business put on a deal carries its hours: its call goes only while it is open", async () => {
    await call(fx, "discover", { category: "plumber", area: "Oakland, CA" });
    const before = new Date();
    const r = await call(fx, "deal", plumbing({ businesses: [ACE_REF] }));
    const one = r.structuredContent;
    expect(one.ok).toBe(true);
    expect(one.businesses).toEqual([expect.objectContaining({ name: "Ace Plumbing & Drain", channel: "phone", simulated: false })]);
    const scheduled = /scheduled for (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(JSON.stringify(one))?.[1];
    if (contactableAt(ACE_HOURS, before, "America/Los_Angeles")) {
      expect(scheduled).toBeUndefined(); // open now: the call goes at once
    } else {
      // Closed (or in its first/last 30 minutes): scheduled for a moment it may be rung.
      expect(scheduled).toBeDefined();
      expect(contactableAt(ACE_HOURS, new Date(scheduled!), "America/Los_Angeles")).toBe(true);
      expect(Date.parse(scheduled!)).toBeGreaterThan(before.getTime());
    }
  });

  it("area not found and rate limits are explicit; nothing is substituted", async () => {
    expect((await call(fx, "discover", { category: "plumber", area: "Atlantis" })).structuredContent.public_discovery).toMatchObject({ status: "area_not_found", message: expect.stringMatching(/couldn't find "Atlantis"/) });
    const r = (await call(fx, "discover", { category: "ratelimit plumber", area: "Oakland, CA" })).structuredContent;
    expect(r.public_discovery).toMatchObject({ status: "rate_limited", message: expect.stringMatching(/Nothing was substituted/) });
    expect(r.found).toEqual([]);
  });
});
