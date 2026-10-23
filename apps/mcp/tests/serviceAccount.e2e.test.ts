// Account deletion's server half, over HTTP against the production build (`mcp-use start`) in MOCK mode
// with auth required: POST /internal/account/revoke cancels the workspace's open deals, then revokes it,
// after which every service call for that workspace is 401. A retry answers 200 (already_revoked); a
// missing actor, a missing confirmation or a wrong token is refused; other workspaces are untouched.
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
const SERVICE = "svc-acct-0123456789abcdef0123456789abcdef";
const REQUEST = { what: "lunch catering", quantity: 40, unit: "people", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA" };
let proc: ChildProcess;
let id = 0;

async function mcp(method: string, params: Record<string, unknown>, workspace: string) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "x-haggle-service-token": SERVICE, "x-haggle-workspace": workspace },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: JSON.parse(text) };
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, body: JSON.parse(line ? line.slice(6) : text) };
}
async function provision(owner: string): Promise<string> {
  const res = await fetch(`${BASE}/internal/workspaces`, { method: "POST", headers: { "content-type": "application/json", "x-haggle-service-token": SERVICE }, body: JSON.stringify({ owner_ref: owner, cap_usd: 1500 }) });
  return ((await res.json()) as { workspace_id: string }).workspace_id;
}
const revoke = (workspace: string, opts: { actor?: string | null; body?: unknown; token?: string } = {}) =>
  fetch(`${BASE}/internal/account/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-haggle-service-token": opts.token ?? SERVICE, "x-haggle-workspace": workspace,
      ...(opts.actor === null ? {} : { "x-haggle-actor": opts.actor ?? "user-1" }),
    },
    body: JSON.stringify(opts.body ?? { confirm: true }),
  });

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

describe("POST /internal/account/revoke (mock, service token)", () => {
  it("refuses without an actor, without confirmation, with a wrong token or an unknown workspace", async () => {
    const ws = await provision("acct-refusals");
    expect((await revoke(ws, { actor: null })).status).toBe(400);
    expect((await revoke(ws, { body: {} })).status).toBe(400);
    expect((await revoke(ws, { token: "svc-wrong-0123456789abcdef0123456789abcdef" })).status).toBe(401);
    expect((await revoke("ws_u_ffffffffffffffffffffffff")).status).toBe(401);
    expect((await mcp("tools/list", {}, ws)).status).toBe(200); // nothing was revoked
  });

  it("cancels the open deal, revokes the workspace (then 401), is idempotent, and leaves other workspaces alone", async () => {
    const ws = await provision("acct-delete-me");
    const other = await provision("acct-keep-me");
    const deal = await mcp("tools/call", { name: "deal", arguments: { request: REQUEST, budget_usd: 1200, client_request_id: `acct-e2e-${Date.now()}` } }, ws);
    const jobId = deal.body.result.structuredContent.job_id as string;
    expect(jobId).toBeTruthy();

    const res = await revoke(ws);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; revoked: boolean; already_revoked: boolean; cancelled: string[]; not_cancelled: unknown[] };
    expect(body).toMatchObject({ ok: true, revoked: true, already_revoked: false });
    expect(body.cancelled).toContain(jobId);
    expect(body.not_cancelled).toEqual([]);

    expect((await mcp("tools/list", {}, ws)).status).toBe(401);
    expect((await mcp("tools/call", { name: "get_quotes", arguments: { job_id: jobId } }, ws)).status).toBe(401);
    const again = await revoke(ws);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, already_revoked: true });

    expect((await mcp("tools/list", {}, other)).status).toBe(200);
  }, 30_000);
});
