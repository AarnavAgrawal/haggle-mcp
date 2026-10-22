// Adversarial HTTP E2E (production audit 2026-10-21): the built server (`mcp-use start`) with
// authentication required, two real workspaces plus a revoked one, and the live approval policy
// (HAGGLE_APPROVALS=out_of_band: only the approver's coded text approves). The client here is the
// attacker: a model with every tool, no human, no phone. No sequence of tool calls may approve or
// pay, read another workspace, or change who approves. Mock mode (DEMO) so nothing external runs;
// the engine-level tests (packages/engine/tests/approvalSecurity.test.ts) cover the live wiring.
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
const ALPHA = "hgw_alpha_e2e_token_0123456789abcdef";
const BETA = "hgw_beta_e2e_token_0123456789abcdef0";
const REVOKED = "hgw_gamma_e2e_token_0123456789abcdef";
const WORKSPACES = [
  { id: "ws_alpha", name: "Alpha", token: ALPHA, approver_phone: "+14155550101" },
  { id: "ws_beta", name: "Beta", token: BETA, approver_phone: "+14155550202" },
  { id: "ws_gamma", name: "Gamma (revoked)", token: REVOKED, revoked: true },
];
const HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
let proc: ChildProcess;
let id = 0;

async function post(body: unknown, auth?: string) {
  return fetch(`${BASE}/mcp`, { method: "POST", headers: { ...HEADERS, ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body) });
}
async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
  const res = await post({ jsonrpc: "2.0", id: ++id, method, params }, token);
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : text);
  if (msg.error) throw Object.assign(new Error(`${method}: ${JSON.stringify(msg.error)}`), { rpcError: msg.error });
  return msg.result;
}
const as = (token: string) => (name: string, args: Record<string, unknown>) => rpc(token, "tools/call", { name, arguments: args });
const errorOf = (r: { isError?: boolean; content: { text: string }[] }) => (r.isError ? JSON.parse(r.content[0]!.text) : null);
/** A refusal however the tool reports it: an error envelope, a JSON-RPC error, or a thrown settings error. */
const refused = async (p: Promise<{ isError?: boolean }>) => {
  const r = await p.catch((e: Error) => e);
  return r instanceof Error || r.isError === true;
};

const REQUEST = {
  what: "lunch catering", quantity: 40, unit: "people", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA",
  requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }],
};

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_AUTH: "required", HAGGLE_APPROVALS: "out_of_band", HAGGLE_MOCK_WORKSPACES: JSON.stringify(WORKSPACES) };
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

describe("authentication (HTTP)", () => {
  const list = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  it("missing, unknown and revoked credentials are refused; only the handshake runs without one", async () => {
    expect((await post(list)).status).toBe(401);
    expect((await post(list, "hgw_not_a_real_token")).status).toBe(401);
    const revoked = await post(list, REVOKED);
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).error.code).toBe("UNAUTHORIZED");
    const init = await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } } });
    expect(init.status).toBe(200);
    expect((await post(list, ALPHA)).status).toBe(200);
    expect(await (await fetch(`${BASE}/health`)).json()).toMatchObject({ auth: "required", approvals: "out_of_band" });
  });
});

describe("model-only tool sequences (HTTP, two workspaces)", { timeout: 120_000 }, () => {
  let job = "";
  let quoteId = "";
  const alpha = as(ALPHA);
  const beta = as(BETA);

  beforeAll(async () => {
    const deal = await alpha("deal", { request: REQUEST, budget_usd: 1200, approver_email: "agent-inbox@attacker.example", client_request_id: "sec-1" });
    expect(deal.isError).toBeFalsy();
    expect(deal.content[0].text).toMatch(/approver_email ignored/);
    job = deal.structuredContent.job_id;
    let cursor = "0";
    let board;
    for (let i = 0; i < 60; i++) {
      const w = await alpha("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
      cursor = w.structuredContent.cursor;
      board = (await alpha("get_quotes", { job_id: job })).structuredContent;
      for (const q of board.open_questions) await alpha("answer_business", { job_id: job, question_id: q.question_id, answer: "Yes, plates and cutlery for 40 please." });
      if (board.ready) break;
    }
    expect(board.ready).toBe(true);
    quoteId = board.recommended_quote_id;
    expect(quoteId).toBeTruthy();
  }, 120_000);

  it("approve can't approve (no form, no card, no simulated human), and pay refuses", async () => {
    const a = await alpha("approve", { job_id: job, quote_id: quoteId });
    expect(errorOf(a)).toMatchObject({ error: { code: "NO_HUMAN_CHANNEL" } });
    expect(a._meta?.["haggle/approval"]).toBeUndefined();
    expect(errorOf(await alpha("pay", { job_id: job, quote_id: quoteId }))).toMatchObject({ error: { code: "no_approval" } });
  });

  it("the board's tools never hand out a code, and a guessed code never approves", async () => {
    const chose = await alpha("choose_in_view", { job_id: job, quote_id: quoteId });
    expect(errorOf(chose)).toMatchObject({ error: { code: "NO_HUMAN_CHANNEL" } });
    expect(chose._meta?.["haggle/approval"]).toBeUndefined();
    for (const code of ["0000", "1234", "9999"]) expect(await refused(alpha("approve_in_view", { approval_id: "ap_guess", code }))).toBe(true);
    const q = (await alpha("get_quotes", { job_id: job })).structuredContent;
    expect(q.approval?.status === "approved").toBe(false);
    expect(errorOf(await alpha("pay", { job_id: job, quote_id: quoteId }))).toMatchObject({ error: { code: "no_approval" } });
  });

  it("settings can't change who approves or raise the spending cap", async () => {
    expect(await refused(alpha("settings.update", { set: { approver_phone: "+14155550666" } }))).toBe(true);
    expect(await refused(alpha("settings.update", { set: { approver_email: "agent@attacker.example" } }))).toBe(true);
    expect(await refused(alpha("settings.update", { set: { spending_cap_usd: 4000 } }))).toBe(true);
    const s = await alpha("settings.read", {});
    expect(s.structuredContent.values).toMatchObject({ approver_phone: "+14155550101", approver_email: "", spending_cap_usd: 1500 });
    // Lowering the cap and the area stay self-service.
    const down = await alpha("settings.update", { set: { spending_cap_usd: 1000, default_area: "San Francisco, CA" } });
    expect(down.structuredContent.values).toMatchObject({ spending_cap_usd: 1000, default_area: "San Francisco, CA" });
  });

  it("another workspace can't see, approve, pay or cancel the deal", async () => {
    for (const [tool, args] of [["get_quotes", { job_id: job }], ["wait_for_update", { job_id: job, cursor: "0", timeout_s: 0 }], ["approve", { job_id: job, quote_id: quoteId }], ["pay", { job_id: job, quote_id: quoteId }], ["cancel_deal", { job_id: job }]] as const) {
      expect(errorOf(await beta(tool, args)), tool).toMatchObject({ error: { code: "job_not_found" } });
    }
    const deals = (await beta("list_deals", {})).structuredContent;
    expect(JSON.stringify(deals)).not.toContain(job);
    expect((await beta("settings.read", {})).structuredContent.values).toMatchObject({ approver_phone: "+14155550202" });
    // client_request_id is per workspace: the same id starts a separate deal, never returns Alpha's.
    const mine = await beta("deal", { request: REQUEST, budget_usd: 1200, client_request_id: "sec-1" });
    expect(mine.structuredContent.job_id).not.toBe(job);
  });

  it("every job-scoped tool refuses Alpha's ids for Beta with job_not_found, and leaks nothing of the deal", async () => {
    const board = (await alpha("get_quotes", { job_id: job })).structuredContent;
    const biz = board.businesses[0].business_id ?? board.businesses[0].id;
    const calls: [string, Record<string, unknown>][] = [
      ["answer_business", { job_id: job, question_id: "q_x", answer: "yes" }], ["send_message", { job_id: job, business_id: biz, text: "hello" }],
      ["negotiate", { job_id: job }], ["get_conversation", { job_id: job, business_id: biz }], ["call_back", { job_id: job, business_id: biz }],
      ["check_price", { job_id: job, quote_id: quoteId }], ["choose_in_view", { job_id: job, quote_id: quoteId }],
    ];
    for (const [tool, args] of calls) {
      const r = await beta(tool, args).catch((e: Error) => e);
      if (r instanceof Error) continue; // refused before reaching the engine (unknown tool on this build)
      const e = (() => { try { return errorOf(r); } catch { return { raw: r.content[0].text }; } })();
      expect(e, tool).toMatchObject({ error: { code: "job_not_found" } });
      expect(JSON.stringify(r), tool).not.toContain(board.businesses[0].name);
    }
    // open_haggle with Alpha's job id never draws Alpha's board for Beta.
    const opened = await beta("open_haggle", { job_id: job });
    expect(JSON.stringify(opened)).not.toContain(quoteId);
  });

  it("business_profile shows only the asking workspace's own history of a shared business", async () => {
    const name = (await alpha("get_quotes", { job_id: job })).structuredContent.quotes[0].business;
    const theirs = await alpha("business_profile", { business: name });
    expect(JSON.stringify(theirs.structuredContent ?? {})).toContain(job);
    const r = await beta("business_profile", { business: name });
    expect(JSON.stringify(r)).not.toContain(job);
  });
});
