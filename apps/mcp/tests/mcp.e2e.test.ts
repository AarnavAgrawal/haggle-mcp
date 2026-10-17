// Transport-level E2E: the real production build (`mcp-use start`) in MOCK mode, driven over
// HTTP JSON-RPC exactly like an MCP client. Simulated fleet (delay scale 0), simulated approval
// (this test client advertises no form capability), simulated payment. Labelled DEMO end to end.
import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let proc: ChildProcess;
let id = 0;

async function rpc(method: string, params: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(line ? line.slice(6) : text);
  if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
  return msg.result;
}
const call = async (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args });

beforeAll(async () => {
  proc = spawn("./node_modules/.bin/mcp-use", ["start"], { env: { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0" }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start");
}, 30_000);
afterAll(() => {
  proc?.kill();
});

describe("Haggle MCP over HTTP (mock mode)", () => {
  it("lists exactly the nine v3 tools, with the deal board bound to get_quotes", async () => {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-e2e", version: "1" } });
    const { tools } = await rpc("tools/list");
    expect(tools.map((t: { name: string }) => t.name).sort()).toEqual(["answer_seller", "approve", "ask", "check_price", "deal", "discover", "get_quotes", "pay", "wait_for_update"]);
    const gq = tools.find((t: { name: string }) => t.name === "get_quotes");
    expect(JSON.stringify(gq._meta ?? {})).toContain("deal-board");
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health).toEqual({ ok: true, service: "haggle-mcp", mode: "mock", tools: 9 });
  });

  it("runs a cold deal end to end through the tools", async () => {
    const found = await call("discover", { category: "catering", area: "San Francisco", count: 6 });
    const businesses = found.structuredContent.businesses.map((b: { name: string; email: string }) => ({ name: b.name, email: b.email }));
    expect(businesses).toHaveLength(6);

    const deal = await call("deal", {
      request: { what: "lunch catering", quantity: 40, unit: "people", date: "2026-10-22", area: "San Francisco, CA",
        requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }] },
      businesses, budget_usd: 1200, client_request_id: "e2e-1",
    });
    expect(deal.isError).toBeFalsy();
    const job = deal.structuredContent.job_id;
    expect(deal.structuredContent.mode).toBe("mock");

    let cursor = "0";
    let quotes;
    for (let i = 0; i < 40; i++) {
      const w = await call("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
      cursor = w.structuredContent.cursor;
      quotes = (await call("get_quotes", { job_id: job })).structuredContent;
      for (const q of quotes.pending_questions) {
        const a = await call("answer_seller", { job_id: job, question_id: q.question_id, answer: "Yes, plates and cutlery for 40 please." });
        expect(a.structuredContent.sent).toBe(true);
      }
      if (quotes.ready) break;
    }
    expect(quotes.ready).toBe(true);
    const bay = quotes.quotes.find((q: { business: string }) => q.business === "Bay Catering");
    expect(quotes.recommended_quote_id).toBe(bay.quote_id);
    expect(bay).toMatchObject({ total_usd: 995, negotiated_from: 1150, deposit_usd: 5 });

    // pay before approval is refused with a fix.
    const early = await call("pay", { job_id: job, quote_id: bay.quote_id });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toContain("approve");

    const ap = await call("approve", { job_id: job, quote_id: bay.quote_id });
    expect(ap.structuredContent).toMatchObject({ status: "approved", quote_total_usd: 995, pay_now_usd: 5 });
    expect(ap.structuredContent.demo).toMatch(/DEMO MODE/);

    await call("pay", { job_id: job, quote_id: bay.quote_id });
    let final;
    for (let i = 0; i < 20; i++) {
      final = (await call("get_quotes", { job_id: job })).structuredContent;
      if (final.state === "paid") break;
      await call("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
    }
    expect(final.state).toBe("paid");
    expect(final.payment).toMatchObject({ status: "settled", simulated: true });
    expect(final.payment.explorer_url).toBeUndefined();

    // Same client_request_id -> same job, no new emails.
    const again = await call("deal", { request: { what: "lunch catering", quantity: 40, date: "2026-10-22", area: "SF", requirements: [] }, businesses, client_request_id: "e2e-1" });
    expect(again.structuredContent.job_id).toBe(job);
  }, 90_000);

  it("returns schema errors and helpful failures", async () => {
    const bad = await call("wait_for_update", { job_id: "job_nope", cursor: "0", timeout_s: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("job_not_found");
    const ask = await call("ask", { what: "lunch", quantity: 25, date: "2026-10-28", area: "San Francisco" });
    expect(ask.structuredContent.note).toBe("estimates, not quotes");
  });
});
