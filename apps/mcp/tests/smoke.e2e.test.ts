// The post-deploy smoke runner (scripts/smoke.ts) against a locally started MOCK server (the built
// entry, as Manufact runs it), plus its refusal to run a deal on a live server (fake fetch).
// Run `mcp-use build` first.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseSmokeArgs, runSmoke } from "../scripts/smoke.ts";

const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => { const p = (srv.address() as AddressInfo).port; srv.close(() => resolve(p)); });
});
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_BUILD_SHA: "smoketest1" };
  proc = WIN ? spawn(`"${BIN}"`, ["start"], { cwd: APP_DIR, env, stdio: "ignore", shell: true }) : spawn(BIN, ["start"], { cwd: APP_DIR, env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start (run `mcp-use build` first)");
}, 30_000);
afterAll(() => {
  if (WIN && proc?.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc?.kill();
});

describe("smoke runner", () => {
  it("parses its arguments", () => {
    expect(parseSmokeArgs(["https://x.run.mcp-use.com/mcp/", "--expect-build", "abc", "--no-deal"], { HAGGLE_SMOKE_TOKEN: "hgw_t" })).toEqual({ base: "https://x.run.mcp-use.com", token: "hgw_t", expectBuild: "abc", deal: false });
    expect(() => parseSmokeArgs([])).toThrow(/usage/);
  });

  it("passes against a local mock server: /health, /ready, MCP tools, and one simulated deal to a quote", async () => {
    const lines: string[] = [];
    const r = await runSmoke({ base: BASE, deal: true, expectBuild: "smoketest1", log: (l) => lines.push(l) });
    expect(r.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["/health:pass", "/ready:pass", "build matches:pass", "MCP initialize:pass", "MCP tools/list:pass", "mock deal:pass"]);
    expect(r.ok).toBe(true);
    const ready = await (await fetch(`${BASE}/ready`)).json();
    expect(ready).toMatchObject({ ready: true, mode: "mock", env: "development", build: "smoketest1", checks: { database: { ok: true, kind: "memory" } } });
  }, 90_000);

  it("never starts a deal on a live server, and reports a failing /ready", async () => {
    const calls: string[] = [];
    const fake = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/health") return Response.json({ ok: true, service: "haggle-mcp", mode: "live", build: "x" });
      if (path === "/ready") return Response.json({ ready: false, mode: "live", checks: { migrations: { ok: false }, database: { ok: true } } }, { status: 503 });
      const body = JSON.parse(String(init?.body));
      calls.push(body.method === "tools/call" ? `tools/call:${body.params.name}` : body.method);
      const result = body.method === "initialize" ? { serverInfo: { name: "haggle", version: "0.6.0" } } : body.method === "tools/list" ? { tools: ["deal", "wait_for_update", "get_quotes", "approve", "pay", "list_deals", "open_haggle"].map((name) => ({ name })) } : {};
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }) as unknown as typeof fetch;
    const r = await runSmoke({ base: "https://live.example", deal: true, fetch: fake });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "/ready")).toMatchObject({ status: "fail", detail: "HTTP 503, failing: migrations" });
    expect(r.checks.find((c) => c.name === "mock deal")).toMatchObject({ status: "skip" });
    expect(calls).toEqual(["initialize", "tools/list"]); // no tool call at all, let alone deal
  });
});
