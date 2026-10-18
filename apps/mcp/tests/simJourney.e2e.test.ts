// The complete simulated purchase over the real MCP HTTP interface, with a server RESTART in the middle:
// deal -> quotes -> (restart) -> resume without ids -> approve (simulated human) -> pay twice (one emulated
// Stripe charge) -> paid board -> warm estimate from what was learned. Mock mode on a throwaway Postgres
// and brain file (scripts/acceptance/sim-journey.sh); skipped without HAGGLE_TEST_DATABASE_URL. No
// outreach, no Stripe call: everything is labelled DEMO.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const DB = process.env.HAGGLE_TEST_DATABASE_URL;
const APP_DIR = join(import.meta.dirname, "..");
const BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].find((p) => existsSync(p)) ?? "mcp-use";
const BRAIN = join(mkdtempSync(join(tmpdir(), "haggle-sim-")), "brain.json");
const freePort = () => new Promise<number>((res, rej) => { const s = createServer().once("error", rej).listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });

let proc: ChildProcess | null = null;
let base = "";
let id = 0;
async function start() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  proc = spawn(BIN, ["start"], { cwd: APP_DIR, stdio: "ignore", env: { ...process.env, PORT: String(port), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_MOCK_DATABASE_URL: DB, HAGGLE_MOCK_BRAIN_FILE: BRAIN } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("server did not start");
}
async function stop() { proc?.kill(); await new Promise((r) => setTimeout(r, 500)); proc = null; }
async function call(name: string, args: Record<string, unknown>) {
  const r = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) });
  const t = await r.text();
  const line = t.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line ? line.slice(6) : t).result;
}
afterAll(() => stop());

describe.skipIf(!DB)("simulated purchase over MCP HTTP with a restart (Postgres)", { timeout: 120_000 }, () => {
  it("deal → quotes → restart → resume without ids → approve → pay once → paid → warm estimate", async () => {
    await start();
    const date = new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 10);
    const deal = (await call("deal", { request: { what: "lunch catering", quantity: 40, date, time: "12:00", area: "San Francisco, CA", venue: "YC office", requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included" }] }, budget_usd: 1200, client_request_id: `sim-${Date.now()}` })).structuredContent;
    expect(deal).toMatchObject({ ok: true, mode: "mock" });
    let cursor = "0";
    let board = deal;
    for (let i = 0; i < 60 && !board.ready; i++) {
      cursor = (await call("wait_for_update", { job_id: deal.job_id, cursor, timeout_s: 1 })).structuredContent.cursor;
      board = (await call("get_quotes", { job_id: deal.job_id })).structuredContent;
      for (const q of board.open_questions) await call("answer_business", { job_id: deal.job_id, question_id: q.question_id, answer: "Yes, plates for 40." });
    }
    expect(board.ready).toBe(true);
    const recommended = board.recommended_quote_id;
    expect(recommended).toBeTruthy();

    // Restart: a fresh process with the same store and memory.
    await stop();
    await start();
    const deals = (await call("list_deals", {})).structuredContent.deals;
    expect(deals.some((d: { job_id: string }) => d.job_id === deal.job_id)).toBe(true);
    const resumed = (await call("get_quotes", { job_id: deal.job_id })).structuredContent;
    expect(resumed).toMatchObject({ job_id: deal.job_id, ready: true, recommended_quote_id: recommended });

    const ap = (await call("approve", { job_id: deal.job_id, quote_id: recommended })).structuredContent;
    expect(ap).toMatchObject({ status: "approved", channel: "simulated", mode: "mock" });
    const pay1 = (await call("pay", { job_id: deal.job_id, quote_id: recommended })).structuredContent;
    const pay2 = (await call("pay", { job_id: deal.job_id, quote_id: recommended })).structuredContent;
    expect(pay1).toMatchObject({ status: "paid", amount_usd: ap.amount_usd });
    expect(pay2).toMatchObject({ status: "paid", amount_usd: ap.amount_usd }); // the same payment, not a second charge
    const paid = (await call("get_quotes", { job_id: deal.job_id })).structuredContent;
    expect(paid.job.state).toBe("paid");
    expect(paid.payment).toMatchObject({ status: "settled", simulated: true });
    expect(paid.payment.receipt_url).toBeUndefined(); // never a receipt link for a simulated charge

    // Restart again: the learned prices are still there for the next agent.
    await stop();
    await start();
    const est = (await call("ask", { what: "lunch catering", quantity: 40, area: "San Francisco, CA" })).structuredContent;
    expect(est.estimates.length).toBeGreaterThan(0);
    expect(JSON.stringify(est)).toMatch(/latest real quote|sample quote/);
  });
});
