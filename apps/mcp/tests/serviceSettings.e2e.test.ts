// The owner's settings over HTTP against the production build (`mcp-use start`) in MOCK mode with auth
// required and a service token: read, change within the ceiling, an approver change that waits for its
// code (mock mode returns the code, labelled simulated), and the refusals: non-owner actor, missing
// actor, foreign or unknown workspace, bad input. The agent's own tool still can't raise the cap.
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
const SERVICE = "svc-e2e-settings-0123456789abcdef012345678";
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
/** What the web app sends as x-haggle-actor: the sign-in email and the account id. */
const actorFor = (owner: string) => `${owner}@example.test (${owner})`;

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

describe("/internal/workspaces/settings over HTTP (mock, service token)", () => {
  it("the owner reads and changes settings, up to the ceiling; the agent's tool still can't raise it", async () => {
    const ws = await provision("settings-user-1");
    const actor = actorFor("settings-user-1");
    const read = await svc("/internal/workspaces/settings", { ws });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ok: true, mode: "mock", settings: { name: "settings-user-1", default_deal_limit_usd: 1500, pending: [] } });
    const ceiling = read.body.settings.ceiling_usd as number;

    const saved = await svc("/internal/workspaces/settings", { ws, actor, body: { name: "Acme Labs", sender_name: "Priya at Acme Labs", timezone: "America/New_York", default_area: "Oakland, CA", default_deal_limit_usd: ceiling } });
    expect(saved.status).toBe(200);
    expect(saved.body.changed.sort()).toEqual(["default_area", "name", "sender_name", "spending_cap_cents", "timezone"]);
    expect(saved.body.settings).toMatchObject({ name: "Acme Labs", sender_name: "Priya at Acme Labs", timezone: "America/New_York", default_area: "Oakland, CA", default_deal_limit_usd: ceiling });

    const over = await svc("/internal/workspaces/settings", { ws, actor, body: { default_deal_limit_usd: ceiling + 0.01 } });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("cap_above_ceiling");

    const cleared = await svc("/internal/workspaces/settings", { ws, actor, body: { sender_name: "", default_area: null, default_deal_limit_usd: 1000 } });
    expect(cleared.body.settings).toMatchObject({ sender_name: null, default_area: null, default_deal_limit_usd: 1000 });

    // The model's settings tool keeps the agent's rules: no raise.
    const raise = await tool(ws, "settings.update", { set: { spending_cap_usd: 1200 } });
    expect(raise.isError).toBe(true);
    expect(raise.content?.[0]?.text).toMatch(/can only be raised by a human/);
    expect((await svc("/internal/workspaces/settings", { ws })).body.settings.default_deal_limit_usd).toBe(1000);
  });

  it("a new approver phone waits for its code; a wrong code is refused; the right one applies it", async () => {
    const ws = await provision("settings-user-2");
    const actor = actorFor("settings-user-2");
    const asked = await svc("/internal/workspaces/settings", { ws, actor, body: { approver_phone: "+1 (415) 555-0177" } });
    expect(asked.status).toBe(200);
    expect(asked.body).toMatchObject({ pending_verification: ["phone"], simulated: true, demo_codes: [{ kind: "phone", code: expect.stringMatching(/^\d{6}$/) }] });
    expect(asked.body.settings.approver.phone).toBeNull();
    expect(asked.body.settings.pending).toEqual([expect.objectContaining({ kind: "phone", attempts_left: 5 })]);
    const code = asked.body.demo_codes[0].code as string;

    const wrong = await svc("/internal/workspaces/settings/confirm", { ws, actor, body: { kind: "phone", code: code === "000000" ? "111111" : "000000" } });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe("wrong_code");

    const ok = await svc("/internal/workspaces/settings/confirm", { ws, actor, body: { kind: "phone", code } });
    expect(ok.status).toBe(200);
    expect(ok.body.confirmed).toBe("phone");
    expect(ok.body.settings.approver.phone).toMatch(/0177$/);
    expect(ok.body.settings.pending).toEqual([]);
    expect((await svc("/internal/workspaces/settings/confirm", { ws, actor, body: { kind: "phone", code } })).status).toBe(409);

    const again = await svc("/internal/workspaces/settings", { ws, actor, body: { approver_email: "ops@acme.test", confirm_url: "https://app.haggle.test/settings" } });
    expect(again.body.pending_verification).toEqual(["email"]);
    const cancelled = await svc("/internal/workspaces/settings/cancel", { ws, actor, body: { kind: "email" } });
    expect(cancelled.body).toMatchObject({ ok: true, cancelled: true, settings: { pending: [] } });
  });

  it("refuses a non-owner actor, a missing actor, another or unknown workspace, and bad input", async () => {
    const a = await provision("settings-user-3");
    const b = await provision("settings-user-4");
    const owner = actorFor("settings-user-3");
    const notOwner = await svc("/internal/workspaces/settings", { ws: a, actor: actorFor("settings-user-4"), body: { default_deal_limit_usd: 100 } });
    expect(notOwner.status).toBe(403);
    expect(notOwner.body.error.code).toBe("NOT_OWNER");
    // a's owner can't act on b by naming it.
    expect((await svc("/internal/workspaces/settings", { ws: b, actor: owner, body: { name: "Mine now" } })).status).toBe(403);
    expect((await svc("/internal/workspaces/settings/confirm", { ws: b, actor: owner, body: { kind: "phone", code: "123456" } })).status).toBe(403);
    const noActor = await svc("/internal/workspaces/settings", { ws: a, body: { name: "X" } });
    expect(noActor.status).toBe(400);
    expect(noActor.body.error.code).toBe("ACTOR_REQUIRED");
    expect((await svc("/internal/workspaces/settings", { ws: "ws_u_ffffffffffffffffffffffff", actor: owner, body: { name: "X" } })).status).toBe(401);
    expect((await svc("/internal/workspaces/settings", { ws: a, actor: owner, body: { name: "X" }, token: "svc-wrong-0123456789abcdef0123456789abcdef" })).status).toBe(401);

    for (const body of [{}, { default_deal_limit_usd: -5 }, { approver_phone: "415-555" }, { approver_email: "not-an-email" }, { surprise: 1 }, { name: "" }, { confirm_url: "http://evil.test/x", name: "Y" }]) {
      const r = await svc("/internal/workspaces/settings", { ws: a, actor: owner, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.code).toBe("INVALID_INPUT");
    }
    const tz = await svc("/internal/workspaces/settings", { ws: a, actor: owner, body: { timezone: "Mars/Olympus" } });
    expect(tz.status).toBe(400);
    expect(tz.body.error.code).toBe("bad_timezone");
    expect((await svc("/internal/workspaces/settings/confirm", { ws: a, actor: owner, body: { kind: "phone", code: "12" } })).status).toBe(400);
    expect((await svc("/internal/workspaces/settings", { ws: b })).body.settings.name).toBe("settings-user-4");
  });
});
