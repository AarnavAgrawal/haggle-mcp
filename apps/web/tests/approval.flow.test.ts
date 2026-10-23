// The web app's approval, payment and callback flows (lib/approval/flow.ts) against a fake Haggle
// client: the ticket path approves in one click (choose_in_view -> approve_in_view with the ticket,
// both as a host), the out-of-band path waits for the approver's text, pay maps refusals, callbacks
// take the demo (code) or text path, and no result ever carries a code. No network.
import { describe, expect, it } from "vitest";
import { approveQuote, authorizeCallback, payQuote, type HostClient } from "../lib/approval/flow.ts";
import { HaggleError, type ToolResult } from "../lib/haggle.ts";

const CODE = "4821";
const CB_CODE = "731904";

type Reply = ToolResult<Record<string, unknown>> | HaggleError;
function fakeHaggle(replies: Record<string, Reply | ((args: Record<string, unknown>) => Reply)>) {
  const calls: { via: "tool" | "host"; name: string; args: Record<string, unknown> }[] = [];
  const answer = (via: "tool" | "host") => async <T,>(name: string, args: Record<string, unknown> = {}): Promise<ToolResult<T>> => {
    calls.push({ via, name, args });
    const r = replies[name];
    const v = typeof r === "function" ? r(args) : r;
    if (!v) throw new HaggleError("RPC_ERROR", `unexpected tool ${name}`, "");
    if (v instanceof HaggleError) throw v;
    return v as ToolResult<T>;
  };
  const client: HostClient = { callTool: answer("tool"), callToolAsHost: answer("host") };
  return { client, calls };
}
const noCode = (o: unknown) => {
  const s = JSON.stringify(o);
  expect(s).not.toContain(CODE);
  expect(s).not.toContain(CB_CODE);
  expect(s).not.toMatch(/"(code|ticket|approval_id)"/);
};

describe("approveQuote", () => {
  it("ticket path: choose_in_view then approve_in_view with the ticket, both as a host, in one call", async () => {
    const { client, calls } = fakeHaggle({
      choose_in_view: { data: { ok: true, mode: "mock", approval_id: "ap_1", status: "pending", action: "pay", amount_usd: 5, next: "Waiting for the human's confirm click on the board (approve_in_view)." }, text: "Board approval pending.", meta: { "haggle/approval": { approval_id: "ap_1", code: CODE } } },
      approve_in_view: (args) =>
        args.code === CODE && args.approval_id === "ap_1"
          ? { data: { ok: true, mode: "mock", status: "approved", outcome: "approved", action: "pay", job_id: "job_1", quote_id: "q_1", next: "Call pay(job_id='job_1', quote_id='q_1') to charge the approved amount.", card: { amount_usd: 5, status: "approved" } }, text: "Approval: approved." }
          : new HaggleError("bad_code", "wrong", "fix"),
    });
    const r = await approveQuote(client, "job_1", "q_1");
    expect(r).toMatchObject({ ok: true, mode: "mock", status: "approved", action: "pay", amount_usd: 5 });
    expect(calls.map((c) => `${c.via}:${c.name}`)).toEqual(["host:choose_in_view", "host:approve_in_view"]);
    expect(calls[0]!.args).toEqual({ job_id: "job_1", quote_id: "q_1" });
    expect(calls[1]!.args).toEqual({ approval_id: "ap_1", code: CODE });
    noCode(r);
  });

  it("passes action=confirm and reports a confirm-only approval as confirmed", async () => {
    const { client, calls } = fakeHaggle({
      choose_in_view: { data: { mode: "mock", status: "pending", action: "confirm", amount_usd: 0 }, text: "", meta: { "haggle/approval": { approval_id: "ap_2", code: CODE } } },
      approve_in_view: { data: { mode: "mock", status: "approved", outcome: "confirmed", action: "confirm", next: "Done: the order is confirmed.", card: { amount_usd: 0 } }, text: "" },
    });
    const r = await approveQuote(client, "job_1", "q_1", "confirm");
    expect(calls[0]!.args).toEqual({ job_id: "job_1", quote_id: "q_1", action: "confirm" });
    expect(r).toMatchObject({ ok: true, status: "confirmed", action: "confirm" });
    noCode(r);
  });

  it("out-of-band path: no ticket, so the approver answers by text (pending_text with the server's next)", async () => {
    const { client, calls } = fakeHaggle({
      choose_in_view: { data: { ok: true, mode: "live", approval_id: "ap_3", status: "pending", action: "pay", amount_usd: 200, next: "Sent to the approver's phone: they approve by replying YES <code> to Haggle's text." }, text: "Approval pending: sent to the approver's phone." },
    });
    const r = await approveQuote(client, "job_1", "q_1");
    expect(r).toEqual({ ok: true, mode: "live", status: "pending_text", action: "pay", amount_usd: 200, next: "Sent to the approver's phone: they approve by replying YES <code> to Haggle's text." });
    expect(calls.map((c) => c.name)).toEqual(["choose_in_view"]);
    noCode(r);
  });

  it("an approval already decided by text is reported, not re-approved", async () => {
    const { client, calls } = fakeHaggle({ choose_in_view: { data: { mode: "live", status: "approved", action: "pay", amount_usd: 50, next: "Approval is approved." }, text: "" } });
    expect(await approveQuote(client, "job_1", "q_1")).toMatchObject({ ok: true, status: "approved" });
    expect(calls).toHaveLength(1);
  });

  it("a locked or expired approval comes back refused; view_only and other refusals keep their fix", async () => {
    const locked = fakeHaggle({
      choose_in_view: { data: { status: "pending" }, text: "", meta: { "haggle/approval": { approval_id: "ap_4", code: CODE } } },
      approve_in_view: { data: { mode: "mock", status: "expired", next: "Approval is expired." }, text: "" },
    });
    const r = await approveQuote(locked.client, "job_1", "q_1");
    expect(r).toMatchObject({ ok: true, status: "refused", reason: "approval expired" });
    noCode(r);

    const viewOnly = fakeHaggle({ choose_in_view: new HaggleError("view_only", "This is a button on Haggle's deal board.", "To ask the human, call approve.", "approve") });
    expect(await approveQuote(viewOnly.client, "job_1", "q_1")).toEqual({ ok: false, error: { code: "view_only", message: "This is a button on Haggle's deal board.", fix: "To ask the human, call approve." }, next: "approve" });

    const down = fakeHaggle({});
    down.client.callToolAsHost = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await approveQuote(down.client, "job_1", "q_1")).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });
});

describe("payQuote", () => {
  it("pays through pay (a plain tool call) and returns the paid card's fields only", async () => {
    const { client, calls } = fakeHaggle({
      pay: { data: { job_id: "job_1", quote_id: "q_1", business: "Bay Catering", amount_usd: 5, status: "paid", mode: "mock", demo: "DEMO MODE: simulated payment; no real funds", payment: { status: "settled", simulated: true }, approval_id: "ap_1", next: "Done." }, text: "Payment settled ($5)." },
    });
    const r = await payQuote(client, "job_1", "q_1");
    expect(r).toEqual({ ok: true, mode: "mock", status: "paid", amount_usd: 5, simulated: true, next: "Done." });
    expect(calls).toEqual([{ via: "tool", name: "pay", args: { job_id: "job_1", quote_id: "q_1" } }]);
    noCode(r);
  });

  it("maps refusals: no approval and over cap become errors with the fix; a refused charge keeps its reason", async () => {
    const none = fakeHaggle({ pay: new HaggleError("no_approval", "No stored human approval for this quote.", "Call approve(job_id, quote_id) first.", "approve") });
    expect(await payQuote(none.client, "job_1", "q_1")).toEqual({ ok: false, error: { code: "no_approval", message: "No stored human approval for this quote.", fix: "Call approve(job_id, quote_id) first." }, next: "approve" });
    const refused = fakeHaggle({ pay: { data: { status: "refused", amount_usd: 5, reason: "card_declined", next: "Payment refused; see reason.", mode: "mock" }, text: "" } });
    expect(await payQuote(refused.client, "job_1", "q_1")).toMatchObject({ ok: true, status: "refused", reason: "card_declined" });
  });

  it("keeps only https receipt links", async () => {
    const ok = fakeHaggle({ pay: { data: { status: "paid", amount_usd: 5, receipt_url: "https://pay.stripe.com/receipts/x", next: "" }, text: "" } });
    expect(await payQuote(ok.client, "j", "q")).toMatchObject({ receipt_url: "https://pay.stripe.com/receipts/x" });
    const bad = fakeHaggle({ pay: { data: { status: "paid", amount_usd: 5, receipt_url: "javascript:alert(1)", next: "" }, text: "" } });
    expect(await payQuote(bad.client, "j", "q")).not.toHaveProperty("receipt_url");
  });
});

describe("authorizeCallback", () => {
  const offer = { ok: true, mode: "mock", business: "Mission Eats", basis_total_usd: 995, their_total_usd: 1070 };

  it("demo path: call_back hands the host a code; the same click spends it on call_back_in_view", async () => {
    const { client, calls } = fakeHaggle({
      call_back: { data: { ...offer, status: "pending_human", next: "Waiting for the human to tap 'Call back' on the deal board." }, text: "", meta: { "haggle/callback": { code: CB_CODE } } },
      call_back_in_view: (args) => (args.code === CB_CODE ? { data: { ...offer, status: "placed", next: "Calling them back." }, text: "" } : new HaggleError("callback_not_authorized", "no", "tap again")),
    });
    const r = await authorizeCallback(client, "job_1", "biz_mission");
    expect(r).toEqual({ ok: true, mode: "mock", status: "placed", business: "Mission Eats", next: "Calling them back." });
    expect(calls.map((c) => `${c.via}:${c.name}`)).toEqual(["host:call_back", "host:call_back_in_view"]);
    expect(calls[1]!.args).toEqual({ job_id: "job_1", business_id: "biz_mission", code: CB_CODE });
    noCode(r);
  });

  it("a deferred call is scheduled", async () => {
    const { client } = fakeHaggle({
      call_back: { data: { ...offer, status: "pending_human" }, text: "", meta: { "haggle/callback": { code: CB_CODE } } },
      call_back_in_view: { data: { ...offer, status: "placed", scheduled_for: "2026-10-23T16:00:00Z", next: "Callback scheduled." }, text: "" },
    });
    expect(await authorizeCallback(client, "job_1", "biz_mission")).toMatchObject({ status: "scheduled", scheduled_for: "2026-10-23T16:00:00Z" });
  });

  it("text path: no code (the approver replies CALL <code>), so pending_text and nothing else is called", async () => {
    const { client, calls } = fakeHaggle({
      call_back: { data: { ...offer, mode: "live", status: "pending_human", next: "Haggle texted the approver: they allow it by replying CALL <code> from their phone." }, text: "" },
    });
    const r = await authorizeCallback(client, "job_1", "biz_mission");
    expect(r).toMatchObject({ ok: true, mode: "live", status: "pending_text" });
    expect(calls).toHaveLength(1);
    noCode(r);
  });

  it("refusals map with their fix", async () => {
    const { client } = fakeHaggle({ call_back: new HaggleError("no_rounds_left", "No negotiation round left.", "Choose among the current quotes (get_quotes, then approve).", "get_quotes") });
    expect(await authorizeCallback(client, "job_1", "biz_mission")).toEqual({ ok: false, error: { code: "no_rounds_left", message: "No negotiation round left.", fix: "Choose among the current quotes (get_quotes, then approve)." }, next: "get_quotes" });
  });
});
