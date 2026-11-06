// Finding food vendors through the real MCP contract (production build, MOCK mode), rehearsed from a
// recorded Amazon Location fixture (tests/fixtures/amazon-catering.json). Text search knows only the two
// caterers; Domino's, Pizza Hut and the restaurants are reachable only through the category and food type
// searches, as on the live API. HAGGLE_MOCK_VENDORS=empty is a server with no demo caterers, like a real
// customer's: deal searches for itself. Nothing is sent anywhere: mock ports only. Run `mcp-use build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const FIXTURE = join(import.meta.dirname, "fixtures/amazon-catering.json");
const freePort = () => new Promise<number>((res, rej) => { const s = createServer().once("error", rej).listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

let proc: ChildProcess;
let base = "";
let id = 0;

async function call(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : t).result;
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_PLACES_FIXTURE: FIXTURE, HAGGLE_MOCK_VENDORS: "empty" };
  proc = WIN ? spawn(`"${BIN}"`, ["start"], { cwd: APP_DIR, stdio: "ignore", env, shell: true }) : spawn(BIN, ["start"], { cwd: APP_DIR, stdio: "ignore", env });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server did not start (run `mcp-use build` first)");
}, 40_000);
afterAll(() => {
  if (WIN && proc?.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc?.kill();
});

const date = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
const catering = (over: Record<string, unknown> = {}, details: { label: string; value: string }[] = []) => ({ request: { what: "catering", quantity: 40, date, area: "Oakland, CA", ...(details.length ? { details } : {}) }, ...over });
const names = (list: { name: string }[]) => list.map((b) => b.name);

describe("discover: a catering search reaches ordinary restaurants", () => {
  it("returns Domino's and Pizza Hut with the caterers, labelled as restaurants that may take large orders", async () => {
    const r = await call("discover", { category: "catering", area: "Oakland, CA", count: 12 });
    const d = r.structuredContent;
    expect(names(d.found)).toEqual(expect.arrayContaining(["Oakland Catering Co", "Domino's", "Pizza Hut", "Taqueria El Paso", "Piedmont Table"]));
    expect(d.found.find((b: { name: string }) => b.name === "Domino's")).toMatchObject({ fit: "adjacent", cuisine: "pizza", price_tier: "budget", chain: "Domino's" });
    expect(d.found.find((b: { name: string }) => b.name === "Oakland Catering Co")).toMatchObject({ fit: "specialist" });
    expect(r.content[0].text).toMatch(/not listed as a caterer/);
  });

  it("says what range the results cover", async () => {
    const d = (await call("discover", { category: "catering", area: "Oakland, CA", count: 12 })).structuredContent;
    expect(d.public_discovery.message).toMatch(/2 caterers, 4 restaurants .*budget to upscale/);
  });

  it("a cuisine steers the order and keeps the other options", async () => {
    const d = (await call("discover", { category: "catering", area: "Oakland, CA", count: 12, cuisine: "Mexican" })).structuredContent;
    expect(d.found[0].name).toBe("Taqueria El Paso");
    expect(names(d.found)).toContain("Domino's");
  });

  it("a price point steers the order", async () => {
    expect((await call("discover", { category: "catering", area: "Oakland, CA", count: 12, price_range: "upscale" })).structuredContent.found[0].name).toBe("Piedmont Table");
    expect((await call("discover", { category: "catering", area: "Oakland, CA", count: 12, price_range: "budget" })).structuredContent.found[0].price_tier).toBe("budget");
  });
});

describe("deal: preferences are asked for and never required", () => {
  it("asks for a cuisine and a price point alongside the missing essentials", async () => {
    const d = (await call("deal", { request: { what: "catering", area: "Oakland, CA" } })).structuredContent;
    expect(d.needs_info.helpful.map((q: { key: string }) => q.key)).toEqual(expect.arrayContaining(["food", "price_range"]));
  });

  it("moves on without them, previews a range, and invites them once", async () => {
    const d = (await call("deal", catering({ dry_run: true }))).structuredContent;
    expect(d).toMatchObject({ ok: true, dry_run: true, discovery: { status: "ok" } });
    expect(names(d.would_contact)).toEqual(expect.arrayContaining(["Oakland Catering Co", "Taqueria El Paso", "Piedmont Table"]));
    expect(d.next).toMatch(/cuisine.*price/i);
  });

  it("doesn't invite preferences the user already gave", async () => {
    const d = (await call("deal", catering({ dry_run: true }, [{ label: "Cuisine", value: "Mexican" }, { label: "Price range", value: "as cheap as possible" }]))).structuredContent;
    expect(d.next).not.toMatch(/optional/i);
    expect(d.would_contact[0].name).toBe("Taqueria El Paso");
  });

  it("names the restaurants it can't email, and keeps their contacts server-side", async () => {
    const d = (await call("deal", catering({ dry_run: true }))).structuredContent;
    expect(names(d.would_contact)).not.toContain("Domino's");
    expect(names(d.discovery.not_emailable)).toEqual(expect.arrayContaining(["Domino's", "Pizza Hut"]));
    expect(d.next).toMatch(/Domino's/);
    expect(JSON.stringify(d.discovery)).not.toMatch(/510555/);
  });
});
