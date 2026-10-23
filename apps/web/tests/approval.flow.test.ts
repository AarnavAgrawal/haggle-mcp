// The web app's approval, payment, callback and purchase flows (lib/approval/flow.ts) against a fake
// client: approvals go through the server's service routes (preview, then the human's decision),
// pay through the pay tool, callbacks and the manual-rail purchase steps through service routes.
// Every result is built field by field: a code the server might (wrongly) send is never passed on,
// and hints telling the human to text a code are left out. No network.
import { describe, expect, it } from "vitest";
import { authorizeCallback, decideApproval, payQuote, previewApproval, purchaseAction, purchaseStatus, type ApprovalClient } from "../lib/approval/flow.ts";
import { HaggleError, type ToolResult } from "../lib/haggle.ts";

const CODE = "4821";

type Reply = Record<string, unknown> | HaggleError;
function fake(tools: Record<string, ToolResult<Record<string, unknown>> | HaggleError> = {}, service: Record<string, Reply | ((body: Record<string, unknown>) => Reply)> = {}) {
  const calls: { via: "tool" | "service"; name: string; args: Record<string, unknown> }[] = [];
  const client: ApprovalClient = {
    async callTool<T>(name: string, args: Record<string, unknown> = {}) {
      calls.push({ via: "tool", name, args });
      const v = tools[name];
      if (!v) throw new HaggleError("RPC_ERROR", `unexpected tool ${name}`, "");
      if (v instanceof HaggleError) throw v;
      return v as ToolResult<T>;
    },
    async service<T>(path: string, body: Record<string, unknown>) {
      calls.push({ via: "service", name: path, args: body });
      const r = service[path];
      const v = typeof r === "function" ? r(body) : r;
      if (!v) throw new HaggleError("HTTP_404", `unexpected path ${path}`, "", null, 404);
      if (v instanceof HaggleError) throw v;
      return v as T;
    },
  };
  return { client, calls };
}
const noCode = (o: unknown) => {
  const s = JSON.stringify(o);
  expect(s).not.toContain(CODE);
  expect(s).not.toMatch(/"code"\s*:\s*"\d/);
};

const REQUESTED = { ok: true, mode: "live", payment_rail: "manual", approval_id: "ap_1", status: "pending", action: "pay", amount_usd: 345, quote_total_usd: 1150, business: "Harbor Table", caveats: ["Delivery fee not confirmed"], expires_at: "2026-10-22T17:00:00Z", next: "Show the human…", code: CODE };

describe("previewApproval", () => {
  it("opens the approval on the server and returns exactly its terms (never a code)", async () => {
    const { client, calls } = fake({}, { "/internal/approvals/request": REQUESTED });
    const r = await previewApproval(client, "job_1", "q_1");
    expect(r).toMatchObject({ ok: true, mode: "live", rail: "manual", approval_id: "ap_1", status: "pending", action: "pay", amount_usd: 345, quote_total_usd: 1150, business: "Harbor Table", caveats: ["Delivery fee not confirmed"] });
    expect(calls).toEqual([{ via: "service", name: "/internal/approvals/request", args: { job_id: "job_1", quote_id: "q_1" } }]);
    noCode(r);
  });

  it("passes action=confirm; refusals keep the server's fix and status", async () => {
    const ok = fake({}, { "/internal/approvals/request": (b) => ({ ...REQUESTED, action: b.action, amount_usd: 0 }) });
    expect(await previewApproval(ok.client, "job_1", "q_1", "confirm")).toMatchObject({ action: "confirm", amount_usd: 0 });
    expect(ok.calls[0]!.args).toEqual({ job_id: "job_1", quote_id: "q_1", action: "confirm" });
    const refused = fake({}, { "/internal/approvals/request": new HaggleError("over_cap", "Over the cap.", "Ask for a smaller deposit.", null, 400) });
    expect(await previewApproval(refused.client, "job_1", "q_1")).toEqual({ ok: false, error: { code: "over_cap", message: "Over the cap.", fix: "Ask for a smaller deposit." }, next: null, status: 400 });
  });
});

describe("decideApproval", () => {
  it("records the human's approve and returns the next step; a hint naming a texted code is dropped", async () => {
    const { client, calls } = fake({}, {
      "/internal/approvals/decide": { ok: true, mode: "live", payment_rail: "manual", approval_id: "ap_1", decision: "approve", status: "approved", changed: true, action: "pay", amount_usd: 345, quote_total_usd: 1150, state: "paying", stage: "awaiting_vendor_confirmation", summary: "Approved by the human. Waiting for Harbor Table to confirm.", next: `Then reply PAID ${CODE}.` },
    });
    const r = await decideApproval(client, "ap_1", "approve");
    expect(r).toMatchObject({ ok: true, rail: "manual", status: "approved", changed: true, state: "paying", stage: "awaiting_vendor_confirmation" });
    expect(calls[0]).toEqual({ via: "service", name: "/internal/approvals/decide", args: { approval_id: "ap_1", decision: "approve" } });
    expect((r as { next: string }).next).toBe("Approved. Nothing is charged until you pay.");
    noCode(r);
  });

  it("a repeated decision is reported as unchanged; an expired one is a refusal with its fix", async () => {
    const again = fake({}, { "/internal/approvals/decide": { ok: true, status: "approved", changed: false, action: "pay", amount_usd: 5, quote_total_usd: 995, next: "pay" } });
    expect(await decideApproval(again.client, "ap_1", "approve")).toMatchObject({ ok: true, status: "approved", changed: false });
    const expired = fake({}, { "/internal/approvals/decide": new HaggleError("approval_expired", "This approval expired.", "Choose the quote again.", null, 409) });
    expect(await decideApproval(expired.client, "ap_1", "approve")).toMatchObject({ ok: false, error: { code: "approval_expired" }, status: 409 });
  });
});

describe("payQuote", () => {
  it("pays through pay (a plain tool call) and returns the paid card's fields only", async () => {
    const { client, calls } = fake({
      pay: { data: { job_id: "job_1", quote_id: "q_1", business: "Bay Catering", amount_usd: 5, status: "paid", mode: "mock", demo: "DEMO", payment: { status: "settled", simulated: true }, approval_id: "ap_1", next: "Done." }, text: "Payment settled ($5)." },
    });
    const r = await payQuote(client, "job_1", "q_1");
    expect(r).toEqual({ ok: true, mode: "mock", status: "paid", amount_usd: 5, simulated: true, next: "Done." });
    expect(calls).toEqual([{ via: "tool", name: "pay", args: { job_id: "job_1", quote_id: "q_1" } }]);
    noCode(r);
  });

  it("maps refusals with their fix; a refused charge keeps its reason; only https receipts", async () => {
    const none = fake({ pay: new HaggleError("no_approval", "No stored human approval for this quote.", "Call approve(job_id, quote_id) first.", "approve") });
    expect(await payQuote(none.client, "job_1", "q_1")).toEqual({ ok: false, error: { code: "no_approval", message: "No stored human approval for this quote.", fix: "Call approve(job_id, quote_id) first." }, next: "approve" });
    const refused = fake({ pay: { data: { status: "refused", amount_usd: 5, reason: "card_declined", next: "", mode: "mock" }, text: "" } });
    expect(await payQuote(refused.client, "job_1", "q_1")).toMatchObject({ ok: true, status: "refused", reason: "card_declined" });
    const bad = fake({ pay: { data: { status: "paid", amount_usd: 5, receipt_url: "javascript:alert(1)", next: "" }, text: "" } });
    expect(await payQuote(bad.client, "j", "q")).not.toHaveProperty("receipt_url");
  });
});

describe("authorizeCallback", () => {
  it("authorizes through the service route; placed, scheduled and refusals", async () => {
    const placed = fake({}, { "/internal/callbacks/authorize": { ok: true, mode: "live", status: "placed", business: "Mission Eats", next: "The deal updates when the call ends." } });
    expect(await authorizeCallback(placed.client, "job_1", "biz_1")).toEqual({ ok: true, mode: "live", status: "placed", business: "Mission Eats", next: "The deal updates when the call ends." });
    expect(placed.calls[0]).toEqual({ via: "service", name: "/internal/callbacks/authorize", args: { job_id: "job_1", business_id: "biz_1" } });
    const later = fake({}, { "/internal/callbacks/authorize": { ok: true, status: "placed", scheduled_for: "2026-10-23T16:00:00Z", next: "" } });
    expect(await authorizeCallback(later.client, "job_1", "biz_1")).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-23T16:00:00Z" });
    const noConsent = fake({}, { "/internal/callbacks/authorize": new HaggleError("callback_no_consent", "Haggle won't call this business back: no recorded consent.", "Negotiate by email or text.", null, 409) });
    expect(await authorizeCallback(noConsent.client, "job_1", "biz_1")).toMatchObject({ ok: false, error: { code: "callback_no_consent", fix: "Negotiate by email or text." }, status: 409 });
  });
});

describe("purchaseStatus", () => {
  const board = (purchase: Record<string, unknown> | undefined, state = "paying", payment?: Record<string, unknown>) => ({ get_quotes: { data: { mode: "live", job: { state }, quotes: [], ...(purchase ? { purchase } : {}), ...(payment ? { payment } : {}) }, text: "" } });

  it("instructions received: the business's text as plain data (link flagged), I've paid allowed; no code-texting hint", async () => {
    const { client } = fake(board({
      stage: "instructions_received", booked: true, money_verified: false, amount_usd: 345, total_usd: 1150, summary: "Harbor confirmed the booking.",
      next: "after paying they reply PAID <code> to Haggle's text.", instructions: { text: "Pay at https://pay.example/inv/1", untrusted: true, has_link: true },
    }));
    const r = await purchaseStatus(client, "job_1");
    expect(r).toMatchObject({ ok: true, rail: "manual", state: "paying", stage: "instructions_received", booked: true, instructions: { text: "Pay at https://pay.example/inv/1", has_link: true }, can: { report_paid: true, accept_booking: false, cancel: true } });
    expect(r).not.toHaveProperty("next");
    noCode(r);
  });

  it("awaiting a booking only the human can confirm: accept allowed, paying not", async () => {
    const { client } = fake(board({ stage: "awaiting_vendor_confirmation", booked: false, money_verified: false, amount_usd: 345, total_usd: 1150, summary: "the human confirms the booking with them directly and replies BOOKED <code>.", next: "Tell the human…" }));
    expect(await purchaseStatus(client, "job_1")).toMatchObject({ can: { report_paid: false, accept_booking: true, cancel: true } });
  });

  it("reported paid and settled: no buttons; the charge rail reports its payment", async () => {
    const reported = fake(board({ stage: "human_reported_paid", booked: true, money_verified: false, summary: "The customer reports paying.", next: "Nothing more." }, "paid"));
    expect(await purchaseStatus(reported.client, "job_1")).toMatchObject({ stage: "human_reported_paid", can: { report_paid: false, accept_booking: false, cancel: false } });
    const charge = fake(board(undefined, "paid", { status: "settled", simulated: true, receipt_url: "http://evil.example" }));
    const r = await purchaseStatus(charge.client, "job_1");
    expect(r).toMatchObject({ rail: "charge", payment: { status: "settled", simulated: true } });
    expect((r as { payment: object }).payment).not.toHaveProperty("receipt_url");
  });
});

describe("purchaseAction", () => {
  it("posts the human's step to its route and returns the next step", async () => {
    const { client, calls } = fake({}, {
      "/internal/purchases/paid": { ok: true, mode: "live", outcome: "reported", state: "paid", stage: "human_reported_paid", summary: "The customer reports paying.", next: "Nothing more for Haggle to do." },
      "/internal/purchases/cancel": { ok: true, state: "cancelled", next: "Nothing to do." },
      "/internal/purchases/booked": new HaggleError("no_booking", "There's no booking waiting for you.", "See the deal page.", null, 409),
    });
    expect(await purchaseAction(client, "job_1", "paid")).toMatchObject({ ok: true, action: "paid", outcome: "reported", stage: "human_reported_paid" });
    expect(await purchaseAction(client, "job_1", "cancel")).toMatchObject({ ok: true, action: "cancel", state: "cancelled" });
    expect(await purchaseAction(client, "job_1", "booked")).toMatchObject({ ok: false, error: { code: "no_booking" }, status: 409 });
    expect(calls.map((c) => c.name)).toEqual(["/internal/purchases/paid", "/internal/purchases/cancel", "/internal/purchases/booked"]);
    for (const c of calls) expect(c.args).toEqual({ job_id: "job_1" });
  });
});
