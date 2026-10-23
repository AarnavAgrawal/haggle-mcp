// Transport-level E2E: the real production build (`mcp-use start`) in MOCK mode, driven over HTTP
// JSON-RPC exactly like an MCP client. Everything external is simulated and labelled DEMO: the
// seller fleet (email + one simulated Voice AI call), approval (this client advertises no form or
// app UI) and payment. Scenario (PLAN §8/§10): 40-person SF lunch, ≥12 vegetarian, delivery, $1,200.
// Run `mcp-use build` first: this starts the built entry, as Manufact does.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApprovalOut as Approval, BOARD_CHAR_BUDGET, BusinessProfile, Conversation, DealBoardOrEmpty, DealBoardPlus, Estimates, Identity } from "../src/views.ts";

// npm workspaces hoist the binary to the repo root; a per-package install keeps it local. On
// Windows the runnable shim is mcp-use.cmd, which needs a shell (and a quoted path).
const APP_DIR = join(import.meta.dirname, "..");
const WIN = process.platform === "win32";
const MCP_USE_BIN = [join(APP_DIR, "node_modules/.bin/mcp-use"), join(APP_DIR, "../../node_modules/.bin/mcp-use")].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p)) ?? "mcp-use";
// A port nobody is listening on (a stale dev server on a random port once answered this suite).
const PORT = await new Promise<number>((resolve, reject) => {
  const srv = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const p = (srv.address() as AddressInfo).port;
    srv.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${PORT}`;
const TICK_SECRET = "e2e-tick-secret-0123456789";
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
  what: "lunch catering", quantity: 40, unit: "people", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), area: "San Francisco, CA",
  requirements: [{ id: "veg12", kind: "dietary", text: "At least 12 vegetarian meals", hard: true, min_count: 12 }, { id: "delivery", kind: "delivery", text: "Delivery included", hard: true }],
};

beforeAll(async () => {
  const env = { ...process.env, PORT: String(PORT), HAGGLE_MODE: "mock", HAGGLE_SIM_DELAY_SCALE: "0", HAGGLE_TICK_SECRET: TICK_SECRET };
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
  // On Windows the server runs under a shell: kill the whole tree, or it keeps the port.
  if (WIN && proc?.pid) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc?.kill();
});

describe("Haggle MCP over HTTP (mock mode)", () => {
  it("initializes and lists the v5 tools; one deal board per deal (deal draws it, open_haggle re-opens it); helpers hidden from the model", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "haggle-e2e", version: "1" } });
    expect(init.serverInfo.name).toBe("haggle");
    const { tools } = await rpc("tools/list");
    const names = tools.map((t: { name: string }) => t.name);
    for (const n of ["ask", "discover", "check_price", "deal", "wait_for_update", "get_quotes", "answer_business", "approve", "pay", "business_profile", "open_haggle", "settings.read", "settings.update", "mention_businesses",
      "get_identity", "send_message", "negotiate", "get_conversation", "cancel_deal", "list_deals", "call_back"]) expect(names).toContain(n);
    const byName = Object.fromEntries(tools.map((t: { name: string }) => [t.name, t]));
    // deal draws the live board once; it refreshes itself. get_quotes and wait_for_update are data only
    // (the board polls them), so a model call never draws a second board in the chat.
    expect(byName.deal._meta.ui.resourceUri).toBe("ui://views/deal-live.html");
    expect(byName.deal.description).toMatch(/^START HERE for any purchase/);
    expect(byName.deal.outputSchema).toBeTruthy();
    expect(byName.get_quotes._meta?.ui).toBeUndefined();
    expect(JSON.stringify(byName.get_quotes._meta ?? {})).not.toContain("deal-board");
    expect(byName.get_quotes.outputSchema).toBeTruthy(); // structured data for the model and the board's refresh
    expect(byName.get_quotes.description).toMatch(/draws no new board/);
    expect(byName.wait_for_update._meta?.ui).toBeUndefined();
    // open_haggle is the explicit way to show the board again (launcher entrypoints; optional job_id).
    expect(byName.open_haggle._meta.ui.resourceUri).toBe("ui://views/deal-board.html");
    expect(byName.open_haggle.inputSchema.properties).toHaveProperty("job_id");
    expect(byName.open_haggle.description).toMatch(/only when the user asks/);
    const boundToBoard = tools.filter((t: { _meta?: { ui?: { resourceUri?: string } } }) => /deal-(board|live)/.test(t._meta?.ui?.resourceUri ?? "")).map((t: { name: string }) => t.name).sort();
    expect(boundToBoard).toEqual(["deal", "open_haggle"]);
    expect(byName.approve_in_view._meta.ui.visibility).toEqual(["app"]);
    expect(byName.choose_in_view._meta.ui.visibility).toEqual(["app"]); // the board's Choose button only
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
    expect(invalid.content[0].text).toMatch(/Input validation error.*request\.what/);
    // The catering default needs quantity + date; any other request describes its answers with ask[].
    const noQty = await call("deal", { request: { what: "lunch catering", area: "SF" }, businesses: [{ name: "X", email: "x@x.test" }] });
    expect(errorOf(noQty)).toMatchObject({ error: { code: "INVALID_INPUT" }, next: "deal" });
    const badAsk = await call("deal", { request: { what: "fix a sink", area: "SF", ask: [{ key: "price", label: "Price", type: "money" }], payable_field: "nope" }, businesses: [{ name: "X", email: "x@x.test" }] });
    expect(errorOf(badAsk)).toMatchObject({ error: { code: "bad_ask" } });
    const noJob = await call("wait_for_update", { job_id: "job_nope", cursor: "0", timeout_s: 0 });
    expect(errorOf(noJob)).toMatchObject({ ok: false, mode: "mock", error: { code: "job_not_found" }, next: "list_deals" });
    // No area and no default: the agent asks the user and calls deal again (settings aren't the agent's to change).
    const { area: _area, ...noArea } = REQUEST;
    const where = await call("deal", { request: noArea });
    expect(errorOf(where)).toMatchObject({ error: { code: "area_required" }, next: "deal" });
    expect(errorOf(where).error.fix).toMatch(/Ask the user where/);
    // A request that clearly isn't catering gets one error that says what to pass (ask[]) and that the
    // configured caterers are never substituted, instead of a misleading "needs a headcount".
    const plumbing = await call("deal", { request: { what: "fix a leaking pipe under the kitchen sink", area: "San Francisco, CA" } });
    expect(errorOf(plumbing)).toMatchObject({ error: { code: "ask_required" }, next: "deal" });
    expect(errorOf(plumbing).error.message).toMatch(/plumbing request, not catering/);
    expect(errorOf(plumbing).error.fix).toMatch(/request\.ask.*businesses: \['<the plumbing business the user wants>'\].*catering vendors, and they're never substituted/);
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
    // discover lists the six demo vendors with readiness (mock: all simulated, all ready); contacts stay server-side.
    const found = await call("discover", { category: "catering", area: "San Francisco", count: 6 });
    expect(found.structuredContent).toMatchObject({ ready: 6, total: 6 });
    expect(found.structuredContent.businesses.every((b: { simulated: boolean; ready: boolean }) => b.simulated && b.ready)).toBe(true);
    expect(JSON.stringify(found.structuredContent)).not.toMatch(/\+1415555\d{4}/); // phone numbers never echoed
    expect(found.content[0].text).toMatch(/Configured demo vendors \(catering\): 6 of 6 ready/);
    // No Places key in this server: it says so, and never passes demo vendors off as real results.
    expect(found.structuredContent.public_discovery.status).toBe("not_configured");
    expect(found.structuredContent.found).toEqual([]);
    const businesses = undefined; // deal without businesses uses the ready vendors

    const deal = await call("deal", { request: REQUEST, businesses, budget_usd: 1200, client_request_id: "e2e-1" });
    expect(deal.isError).toBeFalsy();
    expect(deal.content[0].text).toMatch(/^\[DEMO\] /);
    const job = deal.structuredContent.job_id;
    expect(deal.structuredContent.contacted.find((c: { business: string }) => c.business === "Mission Eats")).toMatchObject({ channel: "phone" });
    // The deal result is a full deal board (the view renders it at once) and says which view renders it.
    expect(DealBoardPlus.safeParse(deal.structuredContent).success).toBe(true);
    expect(deal.structuredContent.job.id).toBe(job);
    expect(deal.structuredContent.businesses).toHaveLength(6);
    expect(deal._meta?.ui?.resourceUri).toBe("ui://views/deal-live.html");

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
    const parsed = DealBoardPlus.safeParse(board);
    expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
    // Compact by default (sprint 4): six quotes within the size budget, the full board behind detail: true.
    expect(JSON.stringify(board).length).toBeLessThanOrEqual(BOARD_CHAR_BUDGET);
    expect(board.compact).toBe(true);

    const q = (name: string) => board.quotes.find((x: { business: string }) => x.business === name);
    const biz = (name: string) => board.businesses.find((x: { name: string }) => x.name === name);
    // Bay Catering wins at $995 after negotiating from $1,150.
    expect(board.recommended_quote_id).toBe(q("Bay Catering").quote_id);
    expect(q("Bay Catering")).toMatchObject({ total_usd: 995, negotiated_from: 1150, deposit_usd: 5, verdict: "compliant", channel: "a2a" }); // its Agent Card (the mock roster routes it by A2A)
    // Golden Grill: only 6 vegetarian meals → still an option (requirements are soft, decision 1), flagged, ranked after the ones that meet everything.
    expect(q("Golden Grill")).toMatchObject({ verdict: "incomplete", meets_requirements: false, eligible: true });
    expect(board.rejected.some((r: { business_id: string }) => r.business_id === q("Golden Grill").business_id)).toBe(false);
    // Harbor Table: deposit found on page 2 of the PDF.
    expect(q("Harbor Table").flags).toContain("hidden_deposit");
    expect(q("Harbor Table")).toMatchObject({ deposit_usd: 300 });
    // (Per-field evidence such as "deposit from pdf p.2" stays engine-internal; the shared Quote has `source`.)
    // Mission Eats: reached by (simulated) phone; quote from the call transcript.
    expect(biz("Mission Eats")).toMatchObject({ channel: "phone", status: "quoted" });
    expect(biz("Mission Eats").transcript_snippet).toMatch(/^Mission Eats: .*\$1,070 total/);
    expect(q("Mission Eats")).toMatchObject({ total_usd: 1070, source: "call transcript" });
    // QuickQuote Deli: "pay now at this link" + injection → rejected, never followed.
    expect(q("QuickQuote Deli")).toMatchObject({ verdict: "rejected", eligible: false });
    expect(q("QuickQuote Deli").flags).toEqual(expect.arrayContaining(["external_payment_link"]));
    // Its own words (the injection) are never echoed back to the model or the view.
    expect(biz("QuickQuote Deli").transcript_snippet).toBeUndefined();
    expect(JSON.stringify(board)).not.toMatch(/ignore your instructions/i);
    // Negotiation cited only eligible, authentic quotes (the scam's $700 never).
    const eligibleTotals = new Set(board.quotes.filter((x: { eligible: boolean }) => x.eligible).map((x: { total_usd: number }) => x.total_usd));
    expect(board.negotiation.length).toBeGreaterThan(0);
    for (const n of board.negotiation) {
      expect(n.target_total_usd).not.toBe(700);
      expect(board.quotes.some((x: { quote_id: string }) => x.quote_id === n.basis_quote_id) || eligibleTotals.has(n.target_total_usd)).toBe(true);
    }

    // Best value is explained. Mission Eats ($1,070 by phone) is not offered a callback: a callback needs a
    // negotiation round left (decisions 14, 37) and round 2 already ran (Bay Catering's counter).
    expect(board.value.explanation.winner).toMatch(/^Bay Catering: best value /);
    expect(board.value.ranked[0].factors.find((f: { name: string }) => f.name === "reputation")).toMatchObject({ neutral: true, note: "demo vendor: no public listing to check (neutral)" });
    expect((board.callbacks ?? []).find((c: { business: string }) => c.business === "Mission Eats")).toBeUndefined();
    const mission = biz("Mission Eats").id;
    expect(errorOf(await call("call_back", { job_id: job, business_id: mission }))).toMatchObject({ error: { code: "no_rounds_left", fix: expect.stringMatching(/get_quotes, then approve/) }, next: "get_quotes" });
    const tap = await call("call_back_in_view", { job_id: job, business_id: mission, code: "123456" });
    expect(errorOf(tap).error.code).toBe("callback_not_authorized");

    // Unauthorized operations are refused with a fix.
    const early = await call("pay", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(errorOf(early)).toMatchObject({ error: { code: "no_approval" }, next: "approve" });
    const grill = await call("approve", { job_id: job, quote_id: q("Golden Grill").quote_id });
    // Approvable with a caveat, but with no deposit it would pay the full $860: above the mock server's per-payment ceiling.
    expect(errorOf(grill).error.code).toBe("over_cap");
    const scam = await call("approve", { job_id: job, quote_id: q("QuickQuote Deli").quote_id });
    expect(errorOf(scam).error.code).toBe("quote_not_eligible");
    const ghost = await call("approve", { job_id: job, quote_id: "q_does_not_exist" });
    expect(errorOf(ghost).error.code).toBe("quote_not_found");
    const fakeTap = await call("approve_in_view", { approval_id: "ap_nope", code: "1234" });
    expect(errorOf(fakeTap).error.code).toBe("approval_not_found");

    // Approval (simulated human in mock mode: this client has no approval card or form).
    const ap = await call("approve", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(Approval.safeParse(ap.structuredContent).success).toBe(true);
    // Approve, then pay (decision 2): the human's approval records the OK and charges nothing.
    expect(ap.structuredContent).toMatchObject({ status: "approved", amount_usd: 5, deposit_usd: 5, pay_now_basis: "deposit", action: "pay", business: "Bay Catering", quote_channel: "a2a", channel: "simulated", mode: "mock" });
    expect(ap.structuredContent.summary).toMatch(/\$995 order total/);
    expect(ap.structuredContent.demo).toMatch(/DEMO MODE/);
    expect(ap.structuredContent.next).toMatch(/pay\(job_id=/);
    expect(ap.structuredContent.payment).toBeUndefined(); // nothing charged by the approval

    // pay is the charge: the approved $5 deposit, once.
    const charged = await call("pay", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(charged.structuredContent).toMatchObject({ amount_usd: 5, business: "Bay Catering" });
    let final;
    for (let i = 0; i < 30; i++) {
      final = (await call("get_quotes", { job_id: job })).structuredContent;
      if (final.job.state === "paid") break;
      await call("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
    }
    expect(final.job.state).toBe("paid");
    expect(DealBoardPlus.safeParse(final).success).toBe(true);
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
    // ...or a named deal, explicitly.
    const named = await call("open_haggle", { job_id: job });
    expect(named.structuredContent).toMatchObject({ empty: false, job: { id: job } });
    expect(errorOf(await call("open_haggle", { job_id: "job_nope" }))).toMatchObject({ error: { code: "job_not_found" } });
    // @-mentions find businesses from this deal.
    const m = await call("mention_businesses", { query: "bay" });
    expect(m.structuredContent.items[0]).toMatchObject({ uri: "business://bay-catering", name: "Bay Catering" });
  }, 120_000);

  it("the board's Choose button: a board-only approval, one at a time; the confirm click approves, pay charges", async () => {
    const found = await call("discover", { category: "catering", area: "San Francisco", count: 6 });
    const businesses = found.structuredContent.businesses.map((b: { name: string }) => b.name); // names are enough
    const job = (await call("deal", { request: REQUEST, businesses, budget_usd: 1200, client_request_id: "e2e-choose" })).structuredContent.job_id;
    let cursor = "0";
    let board;
    for (let i = 0; i < 60; i++) {
      const w = await call("wait_for_update", { job_id: job, cursor, timeout_s: 1 });
      cursor = w.structuredContent.cursor;
      board = (await call("get_quotes", { job_id: job })).structuredContent;
      for (const q of board.open_questions) await call("answer_business", { job_id: job, question_id: q.question_id, answer: "Yes, plates for 40." });
      if (board.ready) break;
    }
    expect(board.ready).toBe(true);
    const q = (name: string) => board.quotes.find((x: { business: string }) => x.business === name);

    // The board gets the one-time code in _meta only; nothing model-visible carries it.
    const started = await call("choose_in_view", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(started.structuredContent).toMatchObject({ status: "pending", mode: "mock" });
    const ticket = started._meta["haggle/approval"];
    expect(ticket.code).toMatch(/^\d{4}$/);
    expect(JSON.stringify(started.structuredContent) + started.content[0].text).not.toContain(ticket.code);
    // One approval per job: choosing another option now is refused with a fix, not silently swapped.
    const other = await call("choose_in_view", { job_id: job, quote_id: q("Mission Eats").quote_id });
    expect(errorOf(other)).toMatchObject({ error: { code: "not_approvable" } });
    // Choosing the same quote again reuses the waiting approval.
    expect((await call("choose_in_view", { job_id: job, quote_id: q("Bay Catering").quote_id }))._meta["haggle/approval"]).toEqual(ticket);
    // Unsafe quotes can't be chosen from the board either.
    expect(errorOf(await call("choose_in_view", { job_id: job, quote_id: q("QuickQuote Deli").quote_id }))).toBeTruthy();
    // The human's confirm click records the approval (nothing charged); the board then calls pay.
    const yes = await call("approve_in_view", ticket);
    expect(yes.structuredContent).toMatchObject({ status: "approved", outcome: "approved", action: "pay" });
    expect(yes.structuredContent.card).toMatchObject({ status: "approved", business: "Bay Catering" });
    const paid = await call("pay", { job_id: job, quote_id: q("Bay Catering").quote_id });
    expect(paid.structuredContent).toMatchObject({ status: "paid" });
  }, 120_000);

  it("approving before quotes are final is the human's call, and the approval says it ends the comparison", async () => {
    const deal = await call("deal", { request: { ...REQUEST, what: "team lunch catering (early approve)" }, budget_usd: 2000, client_request_id: "e2e-early" });
    const job = deal.structuredContent.job_id;
    let board = (await call("get_quotes", { job_id: job })).structuredContent;
    for (let i = 0; i < 20 && !board.quotes.some((q: { total_usd: number | null }) => q.total_usd !== null); i++) {
      await call("wait_for_update", { job_id: job, cursor: "0", timeout_s: 1 });
      board = (await call("get_quotes", { job_id: job })).structuredContent;
    }
    expect(board.ready).toBe(false); // still collecting: the case under test
    const first = board.quotes.find((q: { total_usd: number | null; status?: string }) => q.total_usd !== null)!;
    const approved = await call("approve", { job_id: job, quote_id: first.quote_id });
    expect(approved.content[0].text).toMatch(/quotes weren't final yet: approving now ends collecting and negotiating for this deal/);
  });

  it("the Inkbox webhook route is off in mock mode", async () => {
    const r = await fetch(`${BASE}/webhooks/inkbox`, { method: "POST", body: "{}" });
    expect(r.status).toBe(404);
  });

  it("get_identity, any-request deals, conversation, guarded send_message and cancel_deal", async () => {
    const id = await call("get_identity", {});
    expect(Identity.safeParse(id.structuredContent).success).toBe(true);
    expect(id.structuredContent).toMatchObject({ mode: "mock", channels: { email: "ready", phone: "ready" }, workspace: { id: "ws_default" } });
    const businesses = [{ name: "Harbor Table", email: "orders@harbor-table.sim.haggle.dev" }, { name: "Golden Grill", email: "sales@golden-grill.sim.haggle.dev" }];
    const d = await call("deal", {
      request: { what: "fix a leaking kitchen sink", area: "San Francisco, CA", details: [{ label: "Fixture", value: "kitchen sink" }], ask: [{ key: "price", label: "Total price", type: "money" }, { key: "earliest_date", label: "Earliest date", type: "date" }], compare_by: { field: "price" } },
      businesses, client_request_id: "e2e-any",
    });
    expect(d.isError).toBeFalsy();
    const job = d.structuredContent.job_id;
    const board = (await call("get_quotes", { job_id: job })).structuredContent;
    expect(DealBoardPlus.safeParse(board).success).toBe(true);
    expect(board.job.ask.map((f: { key: string }) => f.key)).toEqual(["price", "earliest_date"]);
    const harbor = board.businesses.find((b: { name: string }) => b.name === "Harbor Table").id;
    const convo = await call("get_conversation", { job_id: job, business_id: harbor });
    expect(Conversation.safeParse(convo.structuredContent).success).toBe(true);
    expect(convo.structuredContent.entries[0]).toMatchObject({ direction: "out", kind: "rfq", channel: "email" });
    expect(convo.structuredContent.entries[0].text).toMatch(/Could you reply by .* with:\n- Total price/);
    const invented = await call("send_message", { job_id: job, business_id: harbor, text: "Someone quoted $90. Can you beat it?" });
    expect(errorOf(invented)).toMatchObject({ error: { code: "unverified_amount" } });
    const named = await call("send_message", { job_id: job, business_id: harbor, text: "Golden Grill is faster." });
    expect(errorOf(named)).toMatchObject({ error: { code: "mentions_other_business" } });
    const fine = await call("send_message", { job_id: job, business_id: harbor, text: "Is parking available near you?" });
    expect(fine.structuredContent).toMatchObject({ sent: true, channel: "email" });
    const nego = await call("negotiate", { job_id: job });
    expect(errorOf(nego)).toMatchObject({ error: { code: "not_ready" } });
    const c = await call("cancel_deal", { job_id: job });
    expect(c.structuredContent).toMatchObject({ state: "cancelled" });
    const after = await call("send_message", { job_id: job, business_id: harbor, text: "hello?" });
    expect(errorOf(after)).toMatchObject({ error: { code: "job_closed" } });
  });

  it("auth: an unknown workspace token or connector secret is refused; the handshake stays open; the tick needs its secret", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" };
    const bad = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer hgw_not_a_real_token" }, body: JSON.stringify(init) });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.code).toBe("UNAUTHORIZED");
    const badSecret = await fetch(`${BASE}/c/hgc_not_a_real_secret/mcp`, { method: "POST", headers, body: JSON.stringify(init) });
    expect(badSecret.status).toBe(401);
    const tickNo = await fetch(`${BASE}/internal/tick`, { method: "POST" });
    expect(tickNo.status).toBe(401);
    const tick = await fetch(`${BASE}/internal/tick`, { method: "POST", headers: { authorization: `Bearer ${TICK_SECRET}` } });
    expect(await tick.json()).toMatchObject({ ok: true, failed: 0 });
    const health = await (await fetch(`${BASE}/health`)).json();
    expect(health).toMatchObject({ auth: "open" });
  });
});
