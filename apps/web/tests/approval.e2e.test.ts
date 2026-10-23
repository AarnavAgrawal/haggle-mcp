// The web app's approve-then-pay click against the REAL built Haggle MCP server (`mcp-use start` in
// apps/mcp, MOCK mode, auth required): provision a workspace with the service token, start the
// catering deal with a real haggleClient, wait for the (instant) mock quotes, then run approveQuote
// and payQuote from lib/approval/flow.ts exactly as the routes do. The deal ends paid (simulated) and
// no response carried a code. Run `mcp-use build` in apps/mcp first (this test doesn't build it).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveQuote, payQuote } from "../lib/approval/flow.ts";
import { haggleClient, provisionWorkspace, type HaggleClient } from "../lib/haggle.ts";

const APP_DIR = join(import.meta.dirname, "../../mcp");
const WIN = process.platform === "win32";
const MCP_USE_BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const p = (srv.address() as AddressInfo).port;
    srv.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const SERVICE = "svc-web-e2e-0123456789abcdef0123456789abcdef";
const cfg = { baseUrl: BASE, serviceToken: SERVICE };
let proc: ChildProcess;

const REQUEST = {
  what: "lunch catering", quantity: 40, unit: "people", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA",
  requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }],
};

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_AUTH: "required", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_SERVICE_TOKEN: SERVICE };
  proc = WIN ? spawn(`"${MCP_USE_BIN}"`, ["start"], { cwd: APP_DIR, env, stdio: "ignore", shell: true }) : spawn(MCP_USE_BIN, ["start"], { cwd: APP_DIR, env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start (run `mcp-use build` in apps/mcp first)");
}, 30_000);
afterAll(() => {
  // On Windows the server runs under a shell: kill the whole tree, or it keeps the port.
  if (WIN && proc?.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc?.kill();
});

type Board = {
  ready?: boolean; job: { state: string }; recommended_quote_id?: string;
  quotes: { quote_id: string; business: string; eligible?: boolean }[];
  open_questions: { question_id: string }[];
  payment?: { status: string; simulated: boolean };
};

/** Every response the test saw, raw (data, text and meta), to check no code leaked past the flow. */
async function readyBoard(haggle: HaggleClient, jobId: string): Promise<Board> {
  let cursor = "0";
  let board: Board | undefined;
  for (let i = 0; i < 60; i++) {
    const w = await haggle.callTool<{ cursor: string }>("wait_for_update", { job_id: jobId, cursor, timeout_s: 1 });
    cursor = w.data.cursor;
    board = (await haggle.callTool<Board>("get_quotes", { job_id: jobId })).data;
    for (const q of board.open_questions) await haggle.callTool("answer_business", { job_id: jobId, question_id: q.question_id, answer: "Yes, plates and cutlery for 40 please." });
    if (board.ready) return board;
  }
  throw new Error(`quotes never became ready (state ${board?.job.state})`);
}

describe("web approval flow against the built MCP server (mock)", () => {
  it("approves with one click (host ticket spent server-side), pays, and the deal ends paid (simulated)", async () => {
    const { workspace_id } = await provisionWorkspace(cfg, { owner_ref: `web-e2e-${Date.now()}`, name: "Web e2e", cap_usd: 1500 });
    const haggle = haggleClient(cfg, workspace_id);

    // The flow's host calls go through a recorder so the test can see what the server handed out.
    const seen: { name: string; meta?: Record<string, unknown> }[] = [];
    const recorder = {
      callTool: async <T,>(name: string, args?: Record<string, unknown>) => {
        const r = await haggle.callTool<T>(name, args);
        seen.push({ name, ...(r.meta ? { meta: r.meta } : {}) });
        return r;
      },
      callToolAsHost: async <T,>(name: string, args?: Record<string, unknown>) => {
        const r = await haggle.callToolAsHost<T>(name, args);
        seen.push({ name, ...(r.meta ? { meta: r.meta } : {}) });
        return r;
      },
    };

    const deal = await haggle.callTool<{ job_id: string; mode: string }>("deal", { request: REQUEST, budget_usd: 1200, client_request_id: `web-e2e-${Date.now()}` });
    expect(deal.data.mode).toBe("mock");
    const jobId = deal.data.job_id;
    const board = await readyBoard(haggle, jobId);
    const bay = board.quotes.find((q) => q.business === "Bay Catering");
    expect(bay, JSON.stringify(board.quotes.map((q) => q.business))).toBeTruthy();
    expect(board.recommended_quote_id).toBe(bay!.quote_id);

    // A plain (non-host) caller can't press the board's buttons.
    await expect(haggle.callTool("choose_in_view", { job_id: jobId, quote_id: bay!.quote_id })).rejects.toMatchObject({ code: "view_only" });

    const approved = await approveQuote(recorder, jobId, bay!.quote_id);
    expect(approved).toMatchObject({ ok: true, mode: "mock", status: "approved", action: "pay", amount_usd: 5 });
    // The server did hand this host a ticket, and the flow spent it in the same click.
    const ticket = seen.find((s) => s.name === "choose_in_view")?.meta?.["haggle/approval"] as { code: string } | undefined;
    expect(ticket?.code).toMatch(/^\d{4}$/);
    expect(seen.map((s) => s.name)).toEqual(["choose_in_view", "approve_in_view"]);
    expect(JSON.stringify(approved)).not.toContain(ticket!.code);

    const paid = await payQuote(recorder, jobId, bay!.quote_id);
    expect(paid).toMatchObject({ ok: true, mode: "mock", status: "paid", amount_usd: 5, simulated: true });
    expect(JSON.stringify(paid)).not.toContain(ticket!.code);
    expect(JSON.stringify(paid)).not.toMatch(/"code"/);

    const final = (await haggle.callTool<Board>("get_quotes", { job_id: jobId })).data;
    expect(final.job.state).toBe("paid");
    expect(final.payment).toMatchObject({ status: "settled", simulated: true });

    // Paying again is safe (idempotent) and still reports paid; approving again doesn't re-approve.
    expect(await payQuote(recorder, jobId, bay!.quote_id)).toMatchObject({ ok: true, status: "paid" });
    const again = await approveQuote(recorder, jobId, bay!.quote_id);
    expect(JSON.stringify(again)).not.toContain(ticket!.code);
  }, 120_000);
});
