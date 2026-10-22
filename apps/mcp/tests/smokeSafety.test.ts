// The post-deploy smoke runner (scripts/smoke.ts) never contacts a vendor or a payment provider, in
// any mode, against a LIVE server. The server here is index.ts served in-process (server.fetch, the
// real auth, routes and tool handlers) over a live-mode engine whose every outside port (email, SMS,
// iMessage, phone, A2A, voice, Stripe, payer, Claude extractor, strategist, reputation, reconciler)
// is a trap: any call is recorded and throws. Each smoke mode must pass (or skip the deal) with the
// trap list empty. Nothing real is touched: the store is in memory and no network is used.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HaggleEngine, InMemoryRepository } from "@haggle/engine";
import { runSmoke, type SmokeOptions } from "../scripts/smoke.ts";
import { makeBrain } from "../src/brain.ts";
import { buildRoster, type ChannelStatus } from "../src/vendors.ts";
import { hashSecret } from "../src/workspace.ts";
import type { Runtime } from "../src/runtime.ts";

const TOKEN = "hgw_smoke_safety_token_0123456789abcdef";
const LIVE_ENV = { HAGGLE_MODE: "live", HAGGLE_ENV: "staging", HAGGLE_PROD_DB_HOSTS: "prodref123", INKBOX_API_KEY: "unused-in-this-test", INKBOX_WEBHOOK_SECRET: "unused-in-this-test", ANTHROPIC_API_KEY: "unused-in-this-test", SUPABASE_DB_URL: "postgres://unused@127.0.0.1:1/unused", HAGGLE_PAYMENTS: "manual", HAGGLE_BUILD_SHA: "safety1" };
const CH: ChannelStatus = { email: true, imessage: true, sms: true, phone: true, a2a: true, connectCommand: "connect @haggle", connected: null, callsViaSharedLine: false };

/** Every call on a trap port: "<port>.<method>". */
const touched: string[] = [];
/** A port whose every method records the call and throws (property reads alone are not contact). */
function trap<T>(port: string): T {
  return new Proxy({}, {
    get: (_, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : (..._args: unknown[]) => {
      touched.push(`${port}.${String(prop)}`);
      throw new Error(`smoke safety: ${port}.${String(prop)} was called`);
    }),
  }) as T;
}

const repo = new InMemoryRepository();
const brain = makeBrain([], { HAGGLE_BRAIN_STORE: "memory" });
const engine = new HaggleEngine({
  repo, brain, email: trap("email"), sms: trap("sms"), imessage: trap("imessage"), phone: trap("phone"), a2a: trap("a2a"), voice: trap("voice"),
  stripe: trap("stripe"), payer: trap("payer"), extractor: trap("extractor"), attachments: trap("attachments"), strategist: trap("strategist"), reputation: trap("reputation"),
  reconcile: async () => { touched.push("reconcile"); throw new Error("smoke safety: reconcile was called"); },
  config: { mode: "live", inboxDomain: "inkboxmail.test", sharedInbox: "haggle@inkboxmail.test", collectionWindowMs: 30 * 60_000, negotiationWindowMs: 10 * 60_000, approvalTtlMs: 30 * 60_000, globalPaymentCapCents: 500_000, maxRounds: 1, manualPaymentHandoff: true, recipientAllowlist: ["orders@trapcafe.example"] },
});
const runtime: Runtime = {
  mode: "live", engine, brain, missing: [], roster: async () => buildRoster({}, CH), channels: async () => CH,
  ops: { env: "staging", repo, database: "memory", providers: { inkbox: true, anthropic: true, payments: "manual", alerts: false } },
};

let server: { fetch: (r: Request) => Promise<Response> };
const saved: Record<string, string | undefined> = {};
/** What the smoke runner sent: paths and JSON-RPC methods / tool names. */
const sent: string[] = [];
const viaServer = (async (url: string, init?: RequestInit) => {
  const u = new URL(url);
  const body = init?.body ? JSON.parse(String(init.body)) as { method?: string; params?: { name?: string } } : null;
  sent.push(body ? (body.method === "tools/call" ? `tools/call:${body.params?.name}` : String(body.method)) : `GET ${u.pathname}`);
  return server.fetch(new Request(`http://haggle.test${u.pathname}`, init));
}) as unknown as typeof fetch;

beforeAll(async () => {
  for (const [k, v] of Object.entries(LIVE_ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const rt = await import("../src/runtime.ts");
  server = (await import("../index.ts")).default as never;
  rt.resetRuntime();
  rt.registerLiveFactory(async () => runtime);
  await engine.createWorkspace({ id: "ws_smoke", name: "Smoke safety", tokenHash: hashSecret(TOKEN), connectorSecretHash: hashSecret(`${TOKEN}:connector`), settings: {} });
  touched.length = 0;
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  (await import("../src/runtime.ts")).resetRuntime();
});

const smoke = (o: Partial<SmokeOptions>) => runSmoke({ base: "https://staging.haggle.test", token: TOKEN, deal: true, fetch: viaServer, ...o });

describe("smoke never contacts a vendor or a payment provider (live server, trapped ports)", () => {
  it("--live-readonly: every check passes, only allowlisted read-only tools are called, no port is touched", async () => {
    sent.length = 0;
    const r = await smoke({ readonly: true, deal: false, expectBuild: "safety1" });
    expect(r.checks.filter((c) => c.status === "fail"), JSON.stringify(r.checks)).toEqual([]);
    expect(r.checks.map((c) => `${c.name}:${c.status}`)).toEqual(["/health:pass", "/ready:pass", "build matches:pass", "MCP initialize:pass", "MCP tools/list:pass", "read-only list_deals:pass", "read-only get_identity:pass", "mock deal:skip"]);
    expect(sent.filter((s) => s.startsWith("tools/call:")).sort()).toEqual(["tools/call:get_identity", "tools/call:list_deals"]);
    expect(touched).toEqual([]);
  });

  it("default mode against a live server: the deal is skipped before any tool call; no port is touched", async () => {
    sent.length = 0;
    const r = await smoke({});
    expect(r.checks.find((c) => c.name === "mock deal")).toMatchObject({ status: "skip", detail: expect.stringMatching(/server mode is live/) });
    expect(sent.filter((s) => s.startsWith("tools/call:"))).toEqual([]);
    expect(touched).toEqual([]);
  });

  it("--no-deal: no tool call at all; no port is touched", async () => {
    sent.length = 0;
    const r = await smoke({ deal: false });
    expect(r.ok).toBe(true);
    expect(sent.filter((s) => s.startsWith("tools/call:"))).toEqual([]);
    expect(touched).toEqual([]);
  });

  it("a server that lies about its mode still never gets a sending tool from --live-readonly", async () => {
    // /health says mock, every tool is annotated read-only: the runner's own allowlist still holds.
    const lying = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/health") return Response.json({ ok: true, service: "haggle-mcp", mode: "mock", build_sha: "x" });
      if (path === "/ready") return Response.json({ ready: true, mode: "mock", checks: {} });
      const body = JSON.parse(String(init?.body));
      sent.push(body.method === "tools/call" ? `tools/call:${body.params.name}` : body.method);
      const ro = { readOnlyHint: true, openWorldHint: false };
      const result = body.method === "initialize" ? { serverInfo: { name: "haggle", version: "0.6.0" } } : body.method === "tools/list" ? { tools: ["deal", "wait_for_update", "get_quotes", "approve", "pay", "list_deals", "open_haggle", "get_identity", "send_message", "call_back"].map((name) => ({ name, annotations: ro })) } : { structuredContent: { mode: "mock" } };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }) as unknown as typeof fetch;
    sent.length = 0;
    await runSmoke({ base: "https://staging.haggle.test", deal: false, readonly: true, fetch: lying });
    expect(sent.filter((s) => s.startsWith("tools/call:")).sort()).toEqual(["tools/call:get_identity", "tools/call:list_deals"]);
  });

  it("control: the traps do catch contact (a real deal call through the same server touches them)", async () => {
    const res = await viaServer("https://staging.haggle.test/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "deal", arguments: { request: { what: "lunch catering", quantity: 20, date: "2026-11-20", area: "San Francisco, CA" }, businesses: [{ name: "Trap Cafe", email: "orders@trapcafe.example" }], budget_usd: 800 } } }) });
    await res.text();
    expect(touched).toContain("email.send");
  });
});
