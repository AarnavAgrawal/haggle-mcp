// Deployment health against locally started MOCK servers (the built entry, as Manufact runs it):
//  * the production-safe smoke (--live-readonly) calls only allowlisted read-only tools;
//  * a database outage: /health stays 200 (liveness), /ready answers 503 naming the reason, and no
//    connection string reaches the response.
// Run `mcp-use build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertReadOnlyCall, parseSmokeArgs, READONLY_TOOLS, runSmoke, SENDS_OR_PAYS } from "../scripts/smoke.ts";

const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const freePort = () => new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => { const p = (srv.address() as AddressInfo).port; srv.close(() => resolve(p)); });
});
const procs: ChildProcess[] = [];

async function start(extra: Record<string, string>): Promise<string> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", ...extra };
  const proc = WIN ? spawn(`"${BIN}"`, ["start"], { cwd: APP_DIR, env, stdio: "ignore", shell: true }) : spawn(BIN, ["start"], { cwd: APP_DIR, env, stdio: "ignore" });
  procs.push(proc);
  for (let i = 0; i < 80; i++) {
    try { await fetch(`${base}/health`); return base; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start (run `mcp-use build` first)");
}

let healthy = "";
let dbDown = "";
// A port nothing listens on: the database is "down" from the first query.
const DEAD_DB = `postgres://haggle:hunter2pw@127.0.0.1:${await freePort()}/haggle_mock`;

beforeAll(async () => {
  [healthy, dbDown] = await Promise.all([start({ HAGGLE_BUILD_SHA: "readonly1" }), start({ HAGGLE_MOCK_DATABASE_URL: DEAD_DB })]);
}, 40_000);
afterAll(() => {
  for (const p of procs) {
    if (WIN && p.pid) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill();
  }
});

describe("smoke --live-readonly", () => {
  it("parses: --live-readonly never runs a deal", () => {
    expect(parseSmokeArgs(["https://x.example", "--live-readonly"], {})).toEqual({ base: "https://x.example", deal: false, readonly: true });
  });

  it("refuses every sending/paying tool and anything the server doesn't annotate read-only + closed-world", () => {
    const annotated = (name: string, a: Record<string, boolean>) => [{ name, annotations: a }];
    for (const t of SENDS_OR_PAYS) expect(() => assertReadOnlyCall(t, annotated(t, { readOnlyHint: true, openWorldHint: false }))).toThrow(/refused/);
    expect(() => assertReadOnlyCall("list_deals", annotated("list_deals", { readOnlyHint: false, openWorldHint: false }))).toThrow(/does not annotate/);
    expect(() => assertReadOnlyCall("list_deals", annotated("list_deals", { readOnlyHint: true, openWorldHint: true }))).toThrow(/does not annotate/);
    expect(() => assertReadOnlyCall("list_deals", [])).toThrow(/not listed/);
    expect(() => assertReadOnlyCall("toString", annotated("toString", { readOnlyHint: true, openWorldHint: false }))).toThrow(/not a read-only/);
    for (const t of Object.keys(READONLY_TOOLS)) expect(SENDS_OR_PAYS.has(t)).toBe(false);
  });

  it("against a local server: health, readiness, MCP and only the allowlisted read-only tools are called", async () => {
    const called: string[] = [];
    const spy = (async (url: string | URL, init?: RequestInit) => {
      if (init?.body) { const b = JSON.parse(String(init.body)); called.push(b.method === "tools/call" ? `tools/call:${b.params.name}` : b.method); }
      return fetch(url, init);
    }) as typeof fetch;
    const lines: string[] = [];
    const r = await runSmoke({ ...parseSmokeArgs([healthy, "--live-readonly", "--expect-build", "readonly1"], {}), fetch: spy, log: (l) => lines.push(l) });
    expect(r.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["/health:pass", "/ready:pass", "build matches:pass", "MCP initialize:pass", "MCP tools/list:pass", "read-only list_deals:pass", "read-only get_identity:pass", "mock deal:skip"]);
    expect(r.ok).toBe(true);
    expect(called).toEqual(["initialize", "tools/list", "tools/call:list_deals", "tools/call:get_identity"]);
  }, 60_000);

  it("a server that marks a sending tool read-only still never gets it called (fake server)", async () => {
    const called: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/health") return Response.json({ ok: true, service: "haggle-mcp", mode: "live" });
      if (path === "/ready") return Response.json({ ready: true, mode: "live", checks: {} });
      const b = JSON.parse(String(init?.body));
      called.push(b.method === "tools/call" ? `tools/call:${b.params.name}` : b.method);
      const all = ["deal", "wait_for_update", "get_quotes", "approve", "pay", "list_deals", "open_haggle", "get_identity"].map((name) => ({ name, annotations: { readOnlyHint: true, openWorldHint: false } }));
      const result = b.method === "initialize" ? { serverInfo: { name: "haggle" } } : b.method === "tools/list" ? { tools: all } : { structuredContent: { mode: "live" } };
      return Response.json({ jsonrpc: "2.0", id: b.id, result });
    }) as unknown as typeof fetch;
    const r = await runSmoke({ base: "https://prod.example", deal: true, readonly: true, fetch: fake });
    expect(called).toEqual(["initialize", "tools/list", "tools/call:list_deals", "tools/call:get_identity"]);
    expect(r.ok).toBe(true);
  });
});

describe("a database outage", () => {
  it("/health stays 200 (liveness); /ready is 503 with the reason and no connection details", async () => {
    const h = await fetch(`${dbDown}/health`);
    expect(h.status).toBe(200);
    expect(await h.json()).toMatchObject({ ok: true, service: "haggle-mcp", mode: "mock" });
    const t0 = Date.now();
    const res = await fetch(`${dbDown}/ready`);
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(JSON.parse(text)).toMatchObject({ ready: false, checks: { database: { ok: false, kind: "postgres", reason: "unreachable" }, migrations: { reason: "database_unreachable" } } });
    expect(text).not.toMatch(/hunter2pw|127\.0\.0\.1|postgres:\/\/|ECONNREFUSED/);
    // The smoke harness reports it as a failing /ready.
    const r = await runSmoke({ base: dbDown, deal: false, readonly: true });
    expect(r.checks.find((c) => c.name === "/ready")).toMatchObject({ status: "fail", detail: expect.stringMatching(/failing: database$/) });
  }, 40_000);
});
