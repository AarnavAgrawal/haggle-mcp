// The workspace ledger over HTTP against the production build (`mcp-use start`) in MOCK mode with auth
// required and a service token: the guard, the limit, workspace isolation, a simulated deal from first
// contact to paid in one read, what must never leave, and that reading it changes nothing. The allow-list
// and the rows a simulated deal can't produce are in serviceLedger.test.ts.
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
const SERVICE = "svc-e2e-ledger-0123456789abcdef01234567890";
const LEDGER = "/internal/workspaces/ledger";
let proc: ChildProcess;
let id = 0;

async function svc(path: string, opts: { ws?: string; actor?: string; body?: unknown; token?: string | null } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: opts.body === undefined ? "GET" : "POST",
    // No content-type on a GET: the server rejects a JSON content-type without a body (400 "Invalid JSON").
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }), ...(opts.token === null ? {} : { "x-haggle-service-token": opts.token ?? SERVICE }),
      ...(opts.ws ? { "x-haggle-workspace": opts.ws } : {}), ...(opts.actor ? { "x-haggle-actor": opts.actor } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}
async function tool<T = any>(ws: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "x-haggle-service-token": SERVICE, "x-haggle-workspace": ws },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const r = JSON.parse(line ? line.slice(6) : text).result as { isError?: boolean; structuredContent?: T; content?: { text?: string }[] };
  if (r.isError) throw new Error(`${name}: ${r.content?.[0]?.text}`);
  return r.structuredContent as T;
}
const provision = async (owner: string) => (await svc("/internal/workspaces", { body: { owner_ref: owner, name: owner } })).body.workspace_id as string;

const REQUEST = {
  what: "lunch catering", quantity: 40, unit: "people", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA",
  requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }],
};
const startDeal = (ws: string, tag: string) => tool<{ job_id: string }>(ws, "deal", { request: REQUEST, budget_usd: 1200, client_request_id: `ledger-e2e-${tag}-${Date.now()}` });
async function readyBoard(ws: string, jobId: string) {
  let cursor = "0";
  let board: any;
  for (let i = 0; i < 60; i++) {
    cursor = (await tool<{ cursor: string }>(ws, "wait_for_update", { job_id: jobId, cursor, timeout_s: 1 })).cursor;
    board = await tool(ws, "get_quotes", { job_id: jobId });
    for (const q of board.open_questions) await tool(ws, "answer_business", { job_id: jobId, question_id: q.question_id, answer: "Yes, plates and cutlery for 40 please." });
    if (board.ready) return board;
  }
  throw new Error(`quotes never became ready (state ${board?.job.state})`);
}

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

describe("GET /internal/workspaces/ledger over HTTP (mock, service token)", () => {
  it("401 without a token, with a wrong one, and for an unknown or missing workspace", async () => {
    const ws = await provision("ledger-guard");
    expect((await svc(LEDGER, { ws, token: null })).status).toBe(401);
    expect((await svc(LEDGER, { ws, token: "wrong-token-0123456789abcdef0123456789" })).status).toBe(401);
    expect(await svc(LEDGER, { ws: "ws_nobody" })).toMatchObject({ status: 401, body: { ok: false, error: { code: "UNAUTHORIZED" } } });
    expect((await svc(LEDGER)).status).toBe(401);
  });

  it("an empty workspace reads as no deals; a bad limit says how to fix it", async () => {
    const ws = await provision("ledger-empty");
    expect(await svc(LEDGER, { ws })).toMatchObject({ status: 200, body: { ok: true, mode: "mock", deals: [], truncated: false, next: expect.any(String) } });
    for (const limit of ["0", "101", "abc", "1.5"]) {
      const bad = await svc(`${LEDGER}?limit=${limit}`, { ws });
      expect(bad, limit).toMatchObject({ status: 400, body: { ok: false, error: { code: "INVALID_INPUT", fix: expect.stringMatching(/limit/) } } });
    }
  });

  it("a member needs no actor and no owner rights; another workspace never sees the deals; limit and truncated hold", async () => {
    const a = await provision("ledger-a");
    const b = await provision("ledger-b");
    const one = await startDeal(a, "one");
    const two = await startDeal(a, "two");
    const both = await svc(LEDGER, { ws: a });
    expect(both.status).toBe(200);
    expect(both.body.deals.map((d: any) => d.job_id).sort()).toEqual([one.job_id, two.job_id].sort());
    expect(both.body.truncated).toBe(false);
    const only = await svc(`${LEDGER}?limit=1`, { ws: a });
    expect(only.body.deals).toHaveLength(1);
    expect(only.body.truncated).toBe(true);
    const foreign = await svc(LEDGER, { ws: b });
    expect(foreign.body).toMatchObject({ ok: true, deals: [], truncated: false });
    expect(JSON.stringify(foreign.body)).not.toContain(one.job_id);
  }, 60_000);

  it("a deal from first contact to paid, in one read: words, not internals; reading it changes nothing", async () => {
    const ws = await provision("ledger-journey");
    const deal = await startDeal(ws, "journey");
    const board = await readyBoard(ws, deal.job_id);
    const quoteId = board.recommended_quote_id ?? board.quotes[0].quote_id;

    const ready = (await svc(LEDGER, { ws })).body.deals[0];
    expect(ready).toMatchObject({ job_id: deal.job_id, what: "lunch catering", quantity: 40, unit: "people", area: "San Francisco, CA", ready: true, budget_usd: 1200, recommended_quote_id: board.recommended_quote_id, approval: null, payment: null, questions: [] });
    expect(ready.businesses.map((x: any) => [x.id, x.status]).sort()).toEqual(board.businesses.map((x: any) => [x.id, x.status]).sort());
    for (const x of ready.businesses) expect(Object.keys(x).sort()).toEqual(["channel", "id", "name", "status"]);
    const current = ready.quotes.filter((q: any) => q.status === "current");
    expect(current.map((q: any) => q.quote_id).sort()).toEqual(board.quotes.map((q: any) => q.quote_id).sort());
    for (const q of board.quotes) {
      const mine = ready.quotes.find((x: any) => x.quote_id === q.quote_id);
      expect(mine).toMatchObject({ business: q.business, channel: q.channel, total_usd: q.total_usd, round: q.round, source: q.source });
      if (q.negotiated_from !== undefined) expect(mine.negotiated_from).toBe(q.negotiated_from);
    }

    const req = await svc("/internal/approvals/request", { ws, actor: "user-1", body: { job_id: deal.job_id, quote_id: quoteId } });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    const asked = (await svc(LEDGER, { ws })).body.deals[0];
    expect(asked.approval).toMatchObject({ quote_id: quoteId, status: "pending", decided_at: null });
    expect(Object.keys(asked.approval).sort()).toEqual(["amount_usd", "business_id", "channel", "decided_at", "quote_id", "status", "total_usd"]);
    expect(asked.events.map((e: any) => e.text)).toContain("Asked you to approve a quote");

    const yes = await svc("/internal/approvals/decide", { ws, actor: "user-1", body: { approval_id: req.body.approval_id, decision: "approve" } });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(await tool(ws, "pay", { job_id: deal.job_id, quote_id: quoteId })).toMatchObject({ status: "paid" });

    const first = await svc(LEDGER, { ws });
    const paid = first.body.deals[0];
    expect(paid).toMatchObject({ state: "paid", approval: { quote_id: quoteId }, payment: { simulated: true, amount_usd: expect.any(Number), at: expect.any(String) } });
    expect(Object.keys(paid.payment).sort()).toEqual(["amount_usd", "at", "simulated", "status"]);
    expect(paid.businesses.some((x: any) => x.status === "won")).toBe(true);
    if (paid.purchase) expect(Object.keys(paid.purchase)).toEqual(["stage"]);

    expect(paid.events.length).toBeGreaterThan(3);
    expect(paid.events.length).toBeLessThanOrEqual(100);
    expect(paid.events.map((e: any) => e.seq)).toEqual([...paid.events.map((e: any) => e.seq)].sort((x: number, y: number) => y - x));
    for (const e of paid.events) {
      expect(["status", "contact", "quote", "negotiation", "approval", "payment", "problem"]).toContain(e.group);
      expect(e.text).not.toMatch(/\bRFQ\b|\bA2A\b|job_|\bq_|\b[a-z0-9]+_[a-z0-9_]+\b/);
    }
    expect(paid.events.map((e: any) => e.text)).toContain("Waiting for your approval");

    const out = JSON.stringify(first.body);
    expect(out).not.toMatch(/"(code|code_hash|token|attempts|approver|thread_id|idempotency_key|pay_to|stripe_payment_intent_id|email|phone)":/);
    expect(out).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(out).not.toMatch(/\+1\d{10}/);

    // A closed deal holds still, so two reads must match exactly: same deal, same events, nothing appended.
    const again = await svc(LEDGER, { ws });
    expect(again.body).toEqual(first.body);
  }, 120_000);
});
