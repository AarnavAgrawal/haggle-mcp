// P4 (item 7) over HTTP: a MOCK server with HAGGLE_PAYMENTS=manual (DEMO rehearsal of the pilot rail) and
// a service token. What the deal board and approval card receive at each manual stage the mock can
// reach: payments_enabled true (the engine's board read model says false on this rail), web_app true,
// purchase.rail "manual", no Stripe settlement, the stage moving booked → payment reported, and the job
// "paid" meaning only "the customer reports paying" (money_verified false). Nothing here carries a code.
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
const SERVICE = "svc-manual-views-e2e-0123456789abcdef0123456789";
const ACTOR = "ada@example.com";
let proc: ChildProcess;
let rpcId = 0;

const REQUEST = {
  what: "lunch catering", quantity: 40, unit: "people", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA",
  requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }],
};

type Purchase = { stage: string; rail: string; money_verified: boolean; booked: boolean; summary: string; next: string };
type Board = {
  ready?: boolean; job: { state: string }; recommended_quote_id?: string; quotes: { quote_id: string }[]; open_questions: { question_id: string }[];
  payments_enabled?: boolean; web_app?: boolean; payment_rail?: string; purchase?: Purchase; payment?: { status: string; simulated: boolean } | null;
};

async function tool<T = Record<string, unknown>>(ws: string, name: string, args: Record<string, unknown>): Promise<{ sc: T; text: string }> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", "x-haggle-service-token": SERVICE, "x-haggle-workspace": ws },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data: "));
  const r = JSON.parse(line ? line.slice(6) : raw).result as { isError?: boolean; structuredContent?: T; content?: { text?: string }[] };
  const text = r.content?.map((c) => c.text).join(" ") ?? "";
  if (r.isError) throw new Error(`${name}: ${text}`);
  return { sc: r.structuredContent as T, text };
}
async function svc(path: string, ws: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-haggle-service-token": SERVICE, "x-haggle-workspace": ws, "x-haggle-actor": ACTOR },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function provision(owner: string): Promise<string> {
  const res = await fetch(`${BASE}/internal/workspaces`, { method: "POST", headers: { "content-type": "application/json", "x-haggle-service-token": SERVICE }, body: JSON.stringify({ owner_ref: owner, name: owner, cap_usd: 1500 }) });
  return ((await res.json()) as { workspace_id: string }).workspace_id;
}
async function readyBoard(ws: string, jobId: string): Promise<Board> {
  let cursor = "0";
  let board: Board | undefined;
  for (let i = 0; i < 60; i++) {
    cursor = (await tool<{ cursor: string }>(ws, "wait_for_update", { job_id: jobId, cursor, timeout_s: 1 })).sc.cursor;
    board = (await tool<Board>(ws, "get_quotes", { job_id: jobId })).sc;
    for (const q of board.open_questions) await tool(ws, "answer_business", { job_id: jobId, question_id: q.question_id, answer: "Yes, plates and cutlery for 40 please." });
    if (board.ready) return board;
  }
  throw new Error(`quotes never became ready (state ${board?.job.state})`);
}
const board = async (ws: string, jobId: string) => (await tool<Board>(ws, "get_quotes", { job_id: jobId })).sc;
/** No approval/PAID/BOOKED code anywhere (block and error codes are snake_case words, e.g. "over_cap"). */
const noCode = (v: unknown) => expect(JSON.stringify(v)).not.toMatch(/"code"\s*:\s*"(?![a-z_]+")/);

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_AUTH: "required", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_SERVICE_TOKEN: SERVICE, HAGGLE_PAYMENTS: "manual" };
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

describe("manual payment handoff, as the views receive it (mock, HAGGLE_PAYMENTS=manual)", () => {
  it("payments are on, the rail is manual, and the job is 'paid' only as reported (never verified, never Stripe)", async () => {
    const health = (await (await fetch(`${BASE}/health`)).json()) as { payments: string };
    expect(health.payments).toBe("enabled");
    const ws = await provision(`manual-views-${Date.now()}`);
    const deal = await tool<{ job_id: string; payments_enabled?: boolean; web_app?: boolean }>(ws, "deal", { request: REQUEST, budget_usd: 1200, client_request_id: `manual-views-${Date.now()}` });
    expect(deal.sc).toMatchObject({ payments_enabled: true, web_app: true });
    expect(deal.text).not.toMatch(/Payments are off/);
    const ready = await readyBoard(ws, deal.sc.job_id);
    expect(ready).toMatchObject({ payments_enabled: true, web_app: true, payment_rail: "manual" });
    const quoteId = ready.recommended_quote_id ?? ready.quotes[0]!.quote_id;

    // The human approves in the web app.
    const req = await svc("/internal/approvals/request", ws, { job_id: deal.sc.job_id, quote_id: quoteId });
    expect(req.body).toMatchObject({ ok: true, payment_rail: "manual", status: "pending" });
    const yes = await svc("/internal/approvals/decide", ws, { approval_id: req.body.approval_id, decision: "approve" });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);

    // Approved: waiting for the vendor's booking confirmation (or already past it). No Stripe settlement.
    let b = await board(ws, deal.sc.job_id);
    expect(b.payments_enabled).toBe(true);
    expect(b.purchase).toMatchObject({ rail: "manual", money_verified: false });
    expect(b.payment?.status).not.toBe("settled");
    if (b.purchase!.stage === "awaiting_vendor_confirmation") {
      const booked = await svc("/internal/purchases/booked", ws, { job_id: deal.sc.job_id });
      expect(booked.status, JSON.stringify(booked.body)).toBe(200);
      b = await board(ws, deal.sc.job_id);
    }
    expect(["instructions_requested", "instructions_received"]).toContain(b.purchase!.stage);
    expect(b.job.state).toBe("paying");

    // pay under manual reports the handoff on the card (nothing charged).
    const pay = await tool<{ payment_rail?: string; payment?: { rail?: string; status: string }; reason?: string }>(ws, "pay", { job_id: deal.sc.job_id, quote_id: quoteId });
    expect(pay.sc.payment_rail).toBe("manual");
    expect(pay.sc.payment).toMatchObject({ rail: "manual" });
    expect(pay.sc.reason).toMatch(/^instructions_(requested|received): /);
    noCode(pay.sc);

    // The human reports paying (the web app's "I've paid"): the job is "paid", the money isn't verified.
    const paid = await svc("/internal/purchases/paid", ws, { job_id: deal.sc.job_id });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    b = await board(ws, deal.sc.job_id);
    expect(b.job.state).toBe("paid");
    expect(b.purchase).toMatchObject({ stage: "human_reported_paid", rail: "manual", money_verified: false });
    expect(b.payment?.status).toBe("human_reported_paid");
    const open = (await tool<Board>(ws, "open_haggle", { job_id: deal.sc.job_id })).sc;
    expect(open).toMatchObject({ payments_enabled: true, web_app: true, purchase: { stage: "human_reported_paid" } });
    noCode(b);
  }, 120_000);
});
