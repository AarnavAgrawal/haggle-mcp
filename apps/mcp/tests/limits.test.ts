// Request size and rate limits (src/limits.ts): the token bucket, body measurement, the middleware
// with a fake context, then the real production build in mock mode with tight limits, driven over
// HTTP: an over-limit tool call is an MCP tool error with a fix and Retry-After, an oversized body
// is refused before anything parses it. Run `mcp-use build` first (as the other e2e suites).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodySize, limitsFromEnv, limitsMiddleware, TokenBucket, toolCalls, type LimitContext } from "../src/limits.ts";

describe("limits (unit)", () => {
  it("reads limits from the environment: rate limiting on by default in live mode only; invalid values fall back", () => {
    expect(limitsFromEnv({})).toEqual({ mcpMaxBytes: 262_144, webhookMaxBytes: 2_097_152, toolCallsPerMinute: 0, burst: 30 });
    expect(limitsFromEnv({ HAGGLE_MODE: "live" }).toolCallsPerMinute).toBe(120);
    expect(limitsFromEnv({ HAGGLE_MODE: "live", HAGGLE_RATE_TOOL_CALLS_PER_MIN: "0" }).toolCallsPerMinute).toBe(0);
    expect(limitsFromEnv({ HAGGLE_MCP_MAX_BODY_BYTES: "12", HAGGLE_RATE_TOOL_CALLS_BURST: "x" })).toMatchObject({ mcpMaxBytes: 262_144, burst: 30 });
  });

  it("token bucket: a burst, then the refill rate; buckets are per key and bounded", () => {
    let t = 0;
    const b = new TokenBucket(60, 3, () => t, 2); // 1 per second, bursts of 3
    expect([b.take("a"), b.take("a"), b.take("a")].every((r) => r.ok)).toBe(true);
    const over = b.take("a");
    expect(over).toEqual({ ok: false, retryAfterMs: 1000 });
    expect(b.take("b").ok).toBe(true); // another workspace is unaffected
    t += 1000;
    expect(b.take("a").ok).toBe(true);
    expect(b.take("a").ok).toBe(false);
    b.take("c"); // a third key evicts the oldest ("b"): memory stays bounded
    expect(b.take("b", 3).ok).toBe(true);
  });

  it("counts JSON-RPC tool calls in one message or a batch", () => {
    expect(toolCalls({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} })).toEqual({ count: 1, id: 7 });
    expect(toolCalls([{ method: "tools/call", id: 1 }, { method: "tools/list", id: 2 }, { method: "tools/call", id: 3 }])).toEqual({ count: 2, id: null });
    expect(toolCalls({ method: "initialize", id: 1 })).toEqual({ count: 0, id: null });
    expect(toolCalls(null).count).toBe(0);
  });

  it("measures a body by Content-Length, or by reading at most past the cap when there is none", async () => {
    expect(await bodySize(new Request("http://x/", { method: "POST", body: "abc", headers: { "content-length": "3" } }), 10)).toBe(3);
    const big = new ReadableStream({ start(c) { for (let i = 0; i < 100; i++) c.enqueue(new Uint8Array(1024)); c.close(); } });
    expect(await bodySize(new Request("http://x/", { method: "POST", body: big, duplex: "half" } as RequestInit), 4096)).toBeLessThanOrEqual(5 * 1024);
  });

  it("the middleware: 413 before anything parses an oversized body; webhook 5xx answers are reported once per response", async () => {
    const failures: number[] = [];
    const mw = limitsMiddleware({ basePath: "/mcp", config: { mcpMaxBytes: 100, webhookMaxBytes: 200, toolCallsPerMinute: 0, burst: 1 }, onWebhookFailure: (s) => failures.push(s) });
    const ctx = (path: string, body: string, status = 200): LimitContext & { nexted: boolean } => {
      const c = {
        nexted: false,
        req: { path, method: "POST", raw: new Request(`http://x${path}`, { method: "POST", body }), header: () => undefined },
        res: new Response(null, { status }),
        json: (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s }),
      };
      return c;
    };
    const big = ctx("/mcp", "x".repeat(101));
    const r = (await mw(big, async () => { big.nexted = true; })) as Response;
    expect(r.status).toBe(413);
    expect(big.nexted).toBe(false);
    expect(((await r.json()) as { error: { code: string; fix: string } }).error).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    const viaConnector = ctx("/c/secretsecretsecret/mcp", "x".repeat(101));
    expect(((await mw(viaConnector, async () => {})) as Response).status).toBe(413);
    const hook = ctx("/webhooks/inkbox", "x".repeat(150), 503);
    expect(await mw(hook, async () => { hook.nexted = true; })).toBeUndefined();
    expect(hook.nexted).toBe(true);
    expect(failures).toEqual([503]);
    const hookBig = ctx("/webhooks/inkbox", "x".repeat(201));
    expect(((await mw(hookBig, async () => {})) as Response).status).toBe(413);
  });
});

// ───────────────────────────── the real server ─────────────────────────────

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
let proc: ChildProcess;
let rid = 0;

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, retryAfter: res.headers.get("retry-after"), msg: JSON.parse(line ? line.slice(6) : text) };
}
const toolCall = (name: string, args: Record<string, unknown>) => post({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name, arguments: args } });

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_RATE_TOOL_CALLS_PER_MIN: "6", HAGGLE_RATE_TOOL_CALLS_BURST: "3", HAGGLE_MCP_MAX_BODY_BYTES: "4096", HAGGLE_WEBHOOK_MAX_BODY_BYTES: "4096" };
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

describe("limits on the real server (mock mode, tight limits)", () => {
  it("a burst of tool calls past the bucket gets a tool error with a fix and Retry-After; other methods still answer", async () => {
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await toolCall("list_deals", {}));
    expect(results.slice(0, 3).every((r) => r.status === 200 && !r.msg.result?.isError)).toBe(true);
    const over = results[3]!;
    expect(over.status).toBe(200);
    expect(Number(over.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(over.msg.result.isError).toBe(true);
    const err = JSON.parse(over.msg.result.content[0].text);
    expect(err).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" }, next: "wait_for_update" });
    expect(err.error.fix).toMatch(/Wait \d+ s/);
    // Listing tools isn't a tool call: never limited.
    expect((await post({ jsonrpc: "2.0", id: ++rid, method: "tools/list", params: {} })).msg.result.tools.length).toBeGreaterThan(5);
    // A different credential has its own bucket (here: refused as unknown, not rate limited).
    const other = await toolCall("list_deals", {}).then(() => post({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name: "list_deals", arguments: {} } }, { authorization: "Bearer hgw_someoneelse0000" }));
    expect(other.status).toBe(401);
  });

  it("an oversized MCP request or webhook body is refused with 413 and a fix", async () => {
    const big = await post({ jsonrpc: "2.0", id: ++rid, method: "tools/call", params: { name: "deal", arguments: { request: { what: "x".repeat(5000) } } } });
    expect(big.status).toBe(413);
    expect(big.msg.error).toMatchObject({ code: "REQUEST_TOO_LARGE" });
    const hook = await fetch(`${BASE}/webhooks/inkbox`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(5000) }) });
    expect(hook.status).toBe(413);
  });
});
