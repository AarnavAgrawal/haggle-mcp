// Transport-level E2E: the real production build (`mcp-use start`) in MOCK mode, driven over HTTP
// JSON-RPC exactly like an MCP client. Everything external is simulated and labelled DEMO: the
// seller fleet (email + one simulated Voice AI call), approval (this client advertises no form or
// app UI) and payment. Scenario (PLAN §8/§10): 40-person SF lunch, ≥12 vegetarian, delivery, $1,200.
// Run `mcp-use build` first: this starts the built entry, as Manufact does.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalOut as Approval, BusinessProfile, DealBoard, DealBoardOrEmpty, Estimates } from "../src/views.ts";

// npm workspaces hoist the binary to the repo root; a per-package install keeps it local.
const APP_DIR = join(import.meta.dirname, "..");
const MCP_USE_BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].find((p) => existsSync(p)) ?? "mcp-use";
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
  if (msg.error) throw Object.assign(new Error(`${method}: ${JSON.stringify(msg.error)}`), { rpcError: msg.error });
  return msg.result;
}
const call = async (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args });
const errorOf = (r: { isError?: boolean; content: { text: string }[] }) => (r.isError ? JSON.parse(r.content[0]!.text) : null);

const REQUEST = {
  what: "lunch catering", quantity: 40, unit: "people", date: "2026-10-22", area: "San Francisco, CA",
  requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }],
};

beforeAll(async () => {
  proc = spawn(MCP_USE_BIN, ["start"], { cwd: APP_DIR, env: { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0" }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start (run `mcp-use build` first)");
}, 30_000);
afterAll(() => {
  proc?.kill();
});

describe("Haggle MCP over HTTP (mock mode)", () => {
  it("initializes and lists the v5 tools; deal board bound to get_quotes; helpers hidden from the model", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-e2e", version: "1" } });
    expect(init.serverInfo.name).toBe("haggle");
    const { tools } = await rpc("tools/list");
    const names = tools.map((t: { name: string }) => t.name);
    for (const n of ["ask", "discover", "check_price", "deal", "wait_for_update", "get_quotes", "answer_business", "approve", "pay", "business_profile", "open_haggle", "settings.read", "settings.update", "mention_businesses"]) expect(names).toContain(n);
    const byName = Object.fromEntries(tools.map((t: { name: string }) => [t.name, t]));
    expect(JSON.stringify(byName.get_quotes._meta)).toContain("deal-board");
    expect(byName.get_quotes.outputSchema).toBeTruthy();
    expect(byName.approve_in_view._meta.ui.visibility).toEqual(["app"]);
    expect(names).not.toContain("answer_seller"); // views call answer_business now
    expect(byName.open_haggle.inputSchema.required ?? []).toEqual([]);
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health).toMatchObject({ ok: true, mode: "mock", phone: true, brain: "connected" });
  });

  it("open_haggle({}) returns an empty board before any deal", async () => {
    const r = await call("open_haggle", {});
    expect(r.isError).toBeFalsy();
    expect(DealBoardOrEmpty.safeParse(r.structuredContent).success).toBe(true);
    expect(r.structuredContent).toMatchObject({ empty: true, job: null, mode: "mock" });
  });

  it("validates input and returns actionable errors", async () => {
    const invalid = await call("deal", { request: { what: "x" } }); // schema rejection before the handler runs
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toMatch(/Input validation error.*request\.quantity/);
    const noJob = await call("wait_for_update", { job_id: "job_nope", cursor: "0", timeout_s: 0 });
    expect(errorOf(noJob)).toMatchObject({ ok: false, mode: "mock", error: { code: "job_not_found" }, next: "deal" });
    const badPhone = await call("deal", { request: REQUEST, businesses: [{ name: "X", phone: "+1415555012345678" }] });
    expect(badPhone.isError).toBe(true);
    const unknown = await call("business_profile", { business: "nobody-we-know" });
    expect(errorOf(unknown)).toMatchObject({ error: { code: "NOT_LEARNED" }, next: "deal" });
    // The real brain is seeded: a learned business has a profile and the warm path answers instantly.
    const prof = await call("business_profile", { business: "bay-catering" });
    expect(BusinessProfile.safeParse(prof.structuredContent).success).toBe(true);
    expect(prof.structuredContent).toMatchObject({ name: "Bay Catering", mode: "mock" });
    const ask = await call("ask", { what: "lunch catering", quantity: 25, date: "2026-10-28", area: "San Francisco" });
    expect(Estimates.safeParse(ask.structuredContent).success).toBe(true);
    expect(ask.structuredContent.estimates.length).toBeGreaterThan(0);
    expect(ask.structuredContent.note).toMatch(/estimate/i);
  });

  it("settings: read, update within the ceiling, refuse above it", async () => {
    const before = await call("settings.read", {});
    expect(before.structuredContent.values).toMatchObject({ spending_cap_usd: 1500 });
    const up = await call("settings.update", { set: { default_area: "San Francisco, CA", spending_cap_usd: 1200 } });
    expect(up.structuredContent.values).toMatchObject({ default_area: "San Francisco, CA", spending_cap_usd: 1200 });
    const tooHigh = await call("settings.update", { set: { spending_cap_usd: 999_999 } }).catch((e) => e);
    expect(tooHigh instanceof Error || tooHigh.isError).toBeTruthy();
  });

  it("runs the cold catering deal end to end through the tools", async () => {
    const found = await call("discover", { category: "catering", area: "San Francisco", count: 6 });
    const businesses = found.structuredContent.businesses.map((b: { name: string; email?: string; phone?: string }) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}) }));
    expect(businesses).toHaveLength(6);
    expect(found.structuredContent.businesses.every((b: { simulated: boolean }) => b.simulated)).toBe(true);
    expect(found.structuredContent.note).toBeUndefined();
    // Asking for more than the fleet says so (the Inspector chat once got 2 of 6 from a live server silently).
    const more = await call("discover", { category: "catering", area: "San Francisco", count: 8 });
    expect(more.structuredContent.note).toBe("Only 6 of the 8 requested businesses are available.");
    expect(more.content[0].text).toMatch(/^\[DEMO\] .*Only 6 of the 8/);

    const deal = await call("deal", { request: REQUEST, businesses, budget_usd: 1200, client_request_id: "e2e-1" });
    expect(deal.isError).toBeFalsy();
    expect(deal.content[0].text).toMatch(/^\[DEMO\] /);
    const job = deal.structuredContent.job_id;
    expect(deal.structuredContent.contacted.find((c: { business: string }) => c.business === "Mission Eats")).toMatchObject({ channel: "phone" });

    // Duplicate request: same job, nothing re-sent.
    const again = await call("deal", { request: REQUEST, businesses, budget_usd: 1200, client_request_id: "e2e-1" });
    expect(again.structuredContent.job_id).toBe(job);

    let cursor = "0";
    let board;
    let sawQuestion = false;
    for (let i = 0; i < 60; i++) {
      const w = await call("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
      cursor = w.structuredContent.cursor;
      board = (await call("get_quotes", { job_id: job })).structuredContent;
      for (const q of board.open_questions) {
        sawQuestion = true;
        expect(q).toMatchObject({ business: "Sunset Kitchen" });
        expect(q.text).toMatch(/plates/);
        const a = await call("answer_business", { job_id: job, question_id: q.question_id, answer: "Yes, plates and cutlery for 40 please." });
        expect(a.structuredContent.sent).toBe(true);
        const twice = await call("answer_business", { job_id: job, question_id: q.question_id, answer: "again" });
        expect(errorOf(twice).error.code).toBe("already_answered");
      }
      if (board.ready) break;
    }
    expect(sawQuestion).toBe(true);
    expect(board.ready).toBe(true);
    const parsed = DealBoard.safeParse(board);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);

    const q = (name: string) => board.quotes.find((x: { business: string }) => x.business === name);
    const biz = (name: string) => board.businesses.find((x: { name: string }) => x.name === name);
    // Bay Catering wins at $995 after negotiating from $1,150.
    expect(board.recommended_quote_id).toBe(q("Bay Catering").quote_id);
    expect(q("Bay Catering")).toMatchObject({ total_usd: 995, negotiated_from: 1150, deposit_usd: 5, verdict: "compliant", channel: "email" });
    // Golden Grill: only 6 vegetarian meals → rejected.
    expect(q("Golden Grill")).toMatchObject({ verdict: "rejected", meets_requirements: false });
    expect(board.rejected.find((r: { business_id: string }) => r.business_id === q("Golden Grill").business_id).reason).toBe("requirement_unmet");
    // Harbor Table: deposit found on page 2 of the PDF.
    expect(q("Harbor Table").flags).toContain("hidden_deposit");
    expect(q("Harbor Table")).toMatchObject({ deposit_usd: 300 });
    // (Per-field evidence such as "deposit from pdf p.2" stays engine-internal; the shared Quote has `source`.)
    // Mission Eats: reached by (simulated) phone; quote from the call transcript.
    expect(biz("Mission Eats")).toMatchObject({ channel: "phone", status: "quoted" });
    expect(biz("Mission Eats").transcript_snippet).toMatch(/AI assistant/);
    expect(q("Mission Eats")).toMatchObject({ total_usd: 1070, source: "call transcript" });
    // QuickQuote Deli: "pay now at this link" + injection → rejected, never followed.
    expect(q("QuickQuote Deli")).toMatchObject({ verdict: "rejected", eligible: false });
    expect(q("QuickQuote Deli").flags).toEqual(expect.arrayContaining(["external_payment_link"]));
    // Negotiation cited only eligible, authentic quotes (the scam's $700 never).
    const eligibleTotals = new Set(board.quotes.filter((x: { eligible: boolean }) => x.eligible).map((x: { total_usd: number }) => x.total_usd));
    expect(board.negotiation.length).toBeGreaterThan(0);
    for (const n of board.negotiation) {
      expect(n.target_total_usd).not.toBe(700);
      expect(board.quotes.some((x: { quote_id: string }) => x.quote_id === n.basis_quote_id) || eligibleTotals.has(n.target_total_usd)).toBe(true);
    }

    // Unauthorized operations are refused with a fix.
    const early = await call("pay", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(errorOf(early)).toMatchObject({ error: { code: "no_approval" }, next: "approve" });
    const grill = await call("approve", { job_id: job, quote_id: q("Golden Grill").quote_id });
    expect(errorOf(grill).error.code).toBe("quote_not_eligible");
    const scam = await call("approve", { job_id: job, quote_id: q("QuickQuote Deli").quote_id });
    expect(errorOf(scam).error.code).toBe("quote_not_eligible");
    const ghost = await call("approve", { job_id: job, quote_id: "q_does_not_exist" });
    expect(errorOf(ghost).error.code).toBe("quote_not_found");
    const fakeTap = await call("approve_in_view", { approval_id: "ap_nope", code: "1234" });
    expect(errorOf(fakeTap).error.code).toBe("approval_not_found");

    // Approval (simulated human in mock mode: this client has no approval card or form).
    const ap = await call("approve", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(Approval.safeParse(ap.structuredContent).success).toBe(true);
    expect(ap.structuredContent).toMatchObject({ status: "approved", amount_usd: 5, deposit_usd: 5, business: "Bay Catering", quote_channel: "email", channel: "simulated", mode: "mock" });
    expect(ap.structuredContent.summary).toMatch(/\$995 order total/);
    expect(ap.structuredContent.demo).toMatch(/DEMO MODE/);

    await call("pay", { job_id: job, quote_id: q("Bay Catering").quote_id });
    let final;
    for (let i = 0; i < 30; i++) {
      final = (await call("get_quotes", { job_id: job })).structuredContent;
      if (final.job.state === "paid") break;
      await call("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
    }
    expect(final.job.state).toBe("paid");
    expect(DealBoard.safeParse(final).success).toBe(true);
    expect(final.payment).toMatchObject({ status: "settled", simulated: true });
    expect(final.payment.receipt_url).toBeUndefined(); // simulated payments never get a receipt link
    expect(final.businesses.find((b: { name: string }) => b.name === "Bay Catering").status).toBe("won");
    const paidView = await call("pay", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(paidView.structuredContent).toMatchObject({ status: "paid" });
    // The approval card keeps the full payment: the simulated Stripe test-mode rail, one DEMO PaymentIntent.
    expect(paidView.structuredContent.payment).toMatchObject({ status: "settled", rail: "stripe", network: "stripe-test", simulated: true });
    expect(paidView.structuredContent.payment.payment_intent_id).toMatch(/^pi_DEMO/);
    expect(paidView.structuredContent.receipt_url).toBeUndefined();

    // The launcher now opens this deal.
    const home = await call("open_haggle", {});
    expect(home.structuredContent).toMatchObject({ empty: false, job: { id: job } });
    // @-mentions find businesses from this deal.
    const m = await call("mention_businesses", { query: "bay" });
    expect(m.structuredContent.items[0]).toMatchObject({ uri: "business://bay-catering", name: "Bay Catering" });
  }, 120_000);

  it("the Inkbox webhook route is off in mock mode", async () => {
    const r = await fetch(`${BASE}/webhooks/inkbox`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });
});
