// The web app's approval routes (/internal/approvals/*, /internal/purchases/*, /internal/callbacks/*)
// over HTTP against the production build (`mcp-use start`) in MOCK mode with a service token:
// request → decide (approve) → pay through the MCP `pay` tool → paid (simulated). Another workspace's
// approval reads as not found, a decision without x-haggle-actor is refused, a repeated decision is a
// no-op, and no response carries a code. The manual-rail steps (paid, booked, cancel) are covered by
// packages/engine/tests/webApprovals.test.ts (mock servers don't run the manual handoff); here they
// must refuse cleanly. Run `mcp-use build` first.
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
const SERVICE = "svc-approvals-e2e-0123456789abcdef0123456789abcdef";
const ACTOR = "ada@example.com";
let proc: ChildProcess;
let rpcId = 0;

const REQUEST = {
  what: "lunch catering", quantity: 40, unit: "people", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA",
  requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }],
};

async function tool<T = Record<string, unknown>>(ws: string, name: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "x-haggle-service-token": SERVICE, "x-haggle-workspace": ws },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const r = JSON.parse(line ? line.slice(6) : text).result as { isError?: boolean; structuredContent?: T; content?: { text?: string }[] };
  if (r.isError) throw new Error(`${name}: ${r.content?.map((c) => c.text).join(" ")}`);
  return r.structuredContent as T;
}
async function svc(path: string, ws: string | null, body: unknown, actor: string | null = ACTOR) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-haggle-service-token": SERVICE, ...(ws ? { "x-haggle-workspace": ws } : {}), ...(actor ? { "x-haggle-actor": actor } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { error?: { code: string; fix: string } } };
}
async function provision(owner: string): Promise<string> {
  const res = await fetch(`${BASE}/internal/workspaces`, { method: "POST", headers: { "content-type": "application/json", "x-haggle-service-token": SERVICE }, body: JSON.stringify({ owner_ref: owner, name: owner, cap_usd: 1500 }) });
  return ((await res.json()) as { workspace_id: string }).workspace_id;
}

type Board = { ready?: boolean; job: { state: string }; recommended_quote_id?: string; quotes: { quote_id: string; business: string }[]; open_questions: { question_id: string }[]; payment?: { status: string; simulated: boolean } };
async function readyBoard(ws: string, jobId: string): Promise<Board> {
  let cursor = "0";
  let board: Board | undefined;
  for (let i = 0; i < 60; i++) {
    cursor = (await tool<{ cursor: string }>(ws, "wait_for_update", { job_id: jobId, cursor, timeout_s: 1 })).cursor;
    board = await tool<Board>(ws, "get_quotes", { job_id: jobId });
    for (const q of board.open_questions) await tool(ws, "answer_business", { job_id: jobId, question_id: q.question_id, answer: "Yes, plates and cutlery for 40 please." });
    if (board.ready) return board;
  }
  throw new Error(`quotes never became ready (state ${board?.job.state})`);
}
/** No success body ever has a code field (an approval, CALL or CANCEL code). */
const noCode = (b: Record<string, unknown>) => expect(Object.keys(b)).not.toContain("code");

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_AUTH: "required", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_SERVICE_TOKEN: SERVICE };
  delete env.HAGGLE_WEB_APPROVALS;
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

describe("web approval routes (mock, service token)", () => {
  it("request → decide → pay ends paid (simulated); repeats are no-ops; other workspaces and missing actors are refused", async () => {
    const ws = await provision(`approvals-e2e-${Date.now()}`);
    const other = await provision(`approvals-e2e-other-${Date.now()}`);
    const deal = await tool<{ job_id: string }>(ws, "deal", { request: REQUEST, budget_usd: 1200, client_request_id: `approvals-e2e-${Date.now()}` });
    const board = await readyBoard(ws, deal.job_id);
    const quoteId = board.recommended_quote_id ?? board.quotes[0]!.quote_id;

    // Bad body, another workspace's job, no workspace header.
    expect((await svc("/internal/approvals/request", ws, { job_id: deal.job_id })).status).toBe(400);
    expect((await svc("/internal/approvals/request", other, { job_id: deal.job_id, quote_id: quoteId })).status).toBe(404);
    expect((await svc("/internal/approvals/request", null, { job_id: deal.job_id, quote_id: quoteId })).status).toBe(401);

    const req = await svc("/internal/approvals/request", ws, { job_id: deal.job_id, quote_id: quoteId });
    expect(req.status, JSON.stringify(req.body)).toBe(200);
    expect(req.body).toMatchObject({ ok: true, mode: "mock", payment_rail: "charge", status: "pending", action: "pay", business: expect.any(String), caveats: expect.any(Array) });
    expect(req.body.amount_usd).toBeGreaterThan(0);
    noCode(req.body);
    const approvalId = req.body.approval_id as string;

    // Decisions: actor required; another workspace can't see it.
    const noActor = await svc("/internal/approvals/decide", ws, { approval_id: approvalId, decision: "approve" }, null);
    expect(noActor).toMatchObject({ status: 400, body: { error: { code: "ACTOR_REQUIRED" } } });
    expect((await svc("/internal/approvals/decide", other, { approval_id: approvalId, decision: "approve" })).status).toBe(404);
    expect((await svc("/internal/approvals/decide", ws, { approval_id: approvalId, decision: "maybe" })).status).toBe(400);

    const yes = await svc("/internal/approvals/decide", ws, { approval_id: approvalId, decision: "approve" });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    expect(yes.body).toMatchObject({ ok: true, status: "approved", changed: true, state: "paying", next: expect.any(String) });
    noCode(yes.body);
    const again = await svc("/internal/approvals/decide", ws, { approval_id: approvalId, decision: "approve" });
    expect(again.body).toMatchObject({ ok: true, status: "approved", changed: false });
    expect((await svc("/internal/approvals/decide", ws, { approval_id: approvalId, decision: "decline" })).status).toBe(409);

    // Mock servers charge through pay (simulated); the manual-rail report is refused.
    const paid = await tool<{ status: string }>(ws, "pay", { job_id: deal.job_id, quote_id: quoteId });
    expect(paid.status).toBe("paid");
    expect((await tool<Board>(ws, "get_quotes", { job_id: deal.job_id })).job.state).toBe("paid");
    const report = await svc("/internal/purchases/paid", ws, { job_id: deal.job_id });
    expect(report).toMatchObject({ status: 400, body: { error: { code: "not_manual_rail" } } });
    expect((await svc("/internal/purchases/paid", ws, { job_id: deal.job_id }, null)).status).toBe(400);
    expect((await svc("/internal/purchases/booked", other, { job_id: deal.job_id })).status).toBe(404);
    // A repeated request for the paid quote reports where it stands (no new approval).
    const after = await svc("/internal/approvals/request", ws, { job_id: deal.job_id, quote_id: quoteId });
    expect(after.body).toMatchObject({ ok: true });
    expect(["approved", "used"]).toContain(after.body.status);
    noCode(after.body);
  }, 120_000);

  it("decline frees the deal; cancel works as the owner; a callback without a justified proposal is refused with the engine's fix", async () => {
    const ws = await provision(`approvals-e2e-2-${Date.now()}`);
    const deal = await tool<{ job_id: string }>(ws, "deal", { request: REQUEST, budget_usd: 1200, client_request_id: `approvals-e2e-2-${Date.now()}` });
    const board = await readyBoard(ws, deal.job_id);
    const quoteId = board.recommended_quote_id ?? board.quotes[0]!.quote_id;
    const req = await svc("/internal/approvals/request", ws, { job_id: deal.job_id, quote_id: quoteId });
    const no = await svc("/internal/approvals/decide", ws, { approval_id: req.body.approval_id, decision: "decline" });
    expect(no.body).toMatchObject({ ok: true, status: "declined", changed: true });

    const cb = await svc("/internal/callbacks/authorize", ws, { job_id: deal.job_id, business_id: "no_such_business" });
    expect(cb.status).toBeGreaterThanOrEqual(400);
    expect(cb.body.error?.fix).toEqual(expect.any(String));

    const cancel = await svc("/internal/purchases/cancel", ws, { job_id: deal.job_id });
    expect(cancel.body).toMatchObject({ ok: true, state: "cancelled" });
    noCode(cancel.body);
  }, 120_000);
});
