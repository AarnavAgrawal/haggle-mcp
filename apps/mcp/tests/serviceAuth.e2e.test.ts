// The web app's path into the server, over HTTP against the production build (`mcp-use start`) in
// MOCK mode with auth required: POST /internal/workspaces provisions a user's workspace with the
// service token, then MCP calls carrying x-haggle-service-token + x-haggle-workspace run in that
// workspace. A wrong token, a missing workspace or no credentials is refused. Run `mcp-use build` first.
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
const SERVICE = "svc-e2e-0123456789abcdef0123456789abcdef";
let proc: ChildProcess;
let id = 0;

async function mcp(method: string, params: Record<string, unknown>, headers: Record<string, string>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, body: JSON.parse(text) };
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, body: JSON.parse(line ? line.slice(6) : text) };
}
const provision = (body: unknown, token = SERVICE) =>
  fetch(`${BASE}/internal/workspaces`, { method: "POST", headers: { "content-type": "application/json", "x-haggle-service-token": token }, body: JSON.stringify(body) });

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

describe("web app service access (mock, auth required)", () => {
  it("provisions a workspace once per owner, then MCP calls with the service headers run in it", async () => {
    const first = await provision({ owner_ref: "supabase-user-1", name: "Ada's team", cap_usd: 900 });
    expect(first.status).toBe(201);
    const { workspace_id } = (await first.json()) as { workspace_id: string };
    expect(workspace_id).toMatch(/^ws_u_[a-f0-9]{24}$/);
    const again = await provision({ owner_ref: "supabase-user-1" });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { created: boolean }).created).toBe(false);

    const headers = { "x-haggle-service-token": SERVICE, "x-haggle-workspace": workspace_id };
    const list = await mcp("tools/list", {}, headers);
    expect(list.status).toBe(200);
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toContain("deal");
    const identity = await mcp("tools/call", { name: "get_identity", arguments: {} }, headers);
    expect(identity.body.result.structuredContent).toMatchObject({ spend_cap_usd: 900 }); // this workspace's settings
  });

  it("refuses a wrong service token, an unknown workspace, and requests without credentials", async () => {
    expect((await provision({ owner_ref: "x" }, "svc-wrong-0123456789abcdef0123456789abcdef")).status).toBe(401);
    expect((await provision({})).status).toBe(400);
    expect((await mcp("tools/list", {}, { "x-haggle-service-token": "svc-wrong-0123456789abcdef0123456789abcdef", "x-haggle-workspace": "ws_u_000000000000000000000000" })).status).toBe(401);
    expect((await mcp("tools/list", {}, { "x-haggle-service-token": SERVICE, "x-haggle-workspace": "ws_u_ffffffffffffffffffffffff" })).status).toBe(401);
    expect((await mcp("tools/list", {}, {})).status).toBe(401);
  });
});
