// Engine read model -> shared view schemas. Shaped like the live round trip of 2026-10-17
// (job_512a5d0265b144ed9337: one email seller outside the directory quoted $1,080), so the deal
// board that rendered live in Claude.ai keeps rendering through the shared DealBoard schema.
import { describe, expect, it } from "vitest";
import type { DealBoardData } from "@haggle/engine";
import { ApprovalOut, DealBoard, DealBoardOrEmpty, DealBoardPlus, dealStartedBoard, emptyBoard, toApproval, toDealBoard } from "../src/views.ts";
import { callHoursText, formatField, isLongText, kindLabel, parseToolError, toolErrorText } from "../views/_shared/format.ts";

const request = {
  what: "lunch catering", quantity: 40, unit: "people", date: "2026-10-22", area: "San Francisco, CA", budget_usd: 1200,
  requirements: [{ id: "veg12", kind: "dietary" as const, text: "At least 12 vegetarian meals", hard: true, min_count: 12 }],
};

const quote = {
  kind: "quote" as const, quote_id: "q_live_1", job_id: "job_512a5d0265b144ed9337", business_id: "biz_3f1c0a9e5b7d2c41", business: "Haggle Test Seller",
  channel: "email" as const, total_usd: 1080, deposit_usd: 5, items: ["Lunch buffet for 40 (14 vegetarian)"], meets_requirements: true,
  requirement_results: [{ requirement_id: "veg12", met: true }], missing: [], flags: [], round: 1, confidence: 0.92, source: "email body",
  evidence: { total_usd: { provenance: "stated" as const, source: "email body" } }, status: "current" as const, message_id: "msg_live_1",
  eligible: true, verdict: "compliant" as const, approvable: true,
};

const live = {
  ok: true, mode: "live", next: "Call approve(job_id, quote_id) for the recommended quote.", job_id: "job_512a5d0265b144ed9337", state: "collecting",
  job: { id: "job_512a5d0265b144ed9337", request, state: "collecting", budget_usd: 1200, created_at: "2026-10-17T20:40:00Z", updated_at: "2026-10-17T20:44:00Z" },
  quotes: [quote, { ...quote, quote_id: "q_live_2", business_id: "biz_golden", business: "Golden Grill", total_usd: null, eligible: false, verdict: "incomplete" as const }],
  recommended_quote_id: "q_live_1",
  rejected: [], open_questions: [], pending_questions: [], negotiation: [],
  business_names: { biz_3f1c0a9e5b7d2c41: "Haggle Test Seller", biz_golden: "Golden Grill" },
  businesses: [
    { id: "biz_3f1c0a9e5b7d2c41", business_id: "biz_3f1c0a9e5b7d2c41", name: "Haggle Test Seller", business: "Haggle Test Seller", channel: "email", status: "quoted", engine_status: "quoted", simulated: true, last_event: "Quoted $1,080 by email" },
    { id: "biz_golden", business_id: "biz_golden", name: "Golden Grill", business: "Golden Grill", channel: "email", status: "contacted", engine_status: "contacted", simulated: true, last_event: null },
  ],
  approval: null, payment: null, ready: false, inbox: "haggle@inkboxmail.com", request, budget_usd: 1200,
} as unknown as DealBoardData;

describe("toDealBoard (live-shaped engine data)", () => {
  it("validates against the shared DealBoard and keeps the real $1,080 quote", () => {
    const b = toDealBoard(live, "live");
    expect(DealBoard.safeParse(b).success).toBe(true);
    expect(b).toMatchObject({ mode: "live", recommended_quote_id: "q_live_1", job: { id: "job_512a5d0265b144ed9337", state: "collecting", budget_usd: 1200, requirements: ["At least 12 vegetarian meals"] } });
    expect(b.job.request).toBe("lunch catering for 40 people · Thursday, October 22, 2026 · San Francisco, CA");
    expect(b.quotes).toHaveLength(1); // D2: the reply with no total is not a quote
    expect(b.quotes[0]).toMatchObject({ business: "Haggle Test Seller", channel: "email", total_usd: 1080, eligible: true, verdict: "compliant" });
    expect(b.quotes[0]).not.toHaveProperty("evidence"); // engine-internal fields never reach the view
    expect(b.businesses.find((x) => x.name === "Golden Grill")).toMatchObject({ status: "contacted", last_event: "Contacted" });
  });

  it("deal renders the live board at once: its output is the board (DealBoardPlus) plus the deal fields", () => {
    const r = {
      ok: true, mode: "live" as const, next: "Call wait_for_update with this job_id.", job_id: live.job.id, inbox: "haggle@inkboxmail.com", state: "collecting", eta: "first replies in ~1-5 min",
      contacted: [{ business_id: "biz_golden", business: "Golden Grill", channel: "email" as const, simulated: true }],
      not_contacted: [],
    };
    const out = dealStartedBoard(r, live, live.job.request, "live", { warnings: ["No budget_usd given."], next: r.next });
    expect(DealBoardPlus.safeParse(out).success).toBe(true); // what deal-live (the deal-board view) reads
    expect(out).toMatchObject({ job_id: live.job.id, inbox: "haggle@inkboxmail.com", eta: "first replies in ~1-5 min", job: { id: live.job.id, state: "collecting" }, contacted: [{ business: "Golden Grill" }], warnings: ["No budget_usd given."], next: r.next, mode: "live" });
    expect(out.quotes[0]).toMatchObject({ total_usd: 1080 });
    // The board read failed after outreach went out: a minimal board from the deal result, never an error.
    const fallback = dealStartedBoard({ ...r, not_contacted: [{ business_id: "biz_x", business: "Far Away Deli", channel: "phone" as const, reason: "outside call hours" }] }, null, live.job.request, "live");
    expect(DealBoardPlus.safeParse(fallback).success).toBe(true);
    expect(fallback.job).toMatchObject({ id: live.job.id, request: "lunch catering for 40 people · Thursday, October 22, 2026 · San Francisco, CA", state: "collecting" });
    expect(fallback.businesses).toEqual([
      expect.objectContaining({ name: "Golden Grill", channel: "email", status: "contacted" }),
      expect.objectContaining({ name: "Far Away Deli", status: "unavailable", unavailable_reason: "outside call hours" }),
    ]);
    expect(fallback.quotes).toEqual([]);
  });

  it("an unknown total is null with total_known: false, never $0 (decision 22)", () => {
    const asked = { ...live, quotes: [{ ...live.quotes[1]!, fields: { price: null, earliest_date: "2026-10-25" } }] } as unknown as DealBoardData;
    const b = toDealBoard(asked, "live");
    expect(b.quotes[0]).toMatchObject({ business: "Golden Grill", total_usd: null, total_known: false });
    expect(DealBoard.safeParse(b).success).toBe(false); // core requires a number; Haggle's board schema carries the unknown
    expect(DealBoardPlus.safeParse({ ...b, empty: false }).success).toBe(true);
  });

  it("open_haggle with no deal is an empty board", () => {
    expect(DealBoardOrEmpty.safeParse(emptyBoard("live")).success).toBe(true);
  });

  it("approval card states the order total and the deposit due now", () => {
    const withApproval = { ...live, approval: { approval_id: "ap_1", job_id: live.job.id, quote_id: "q_live_1", quote_total_usd: 1080, payment_usd: 5, cap_usd: 5, approver: "mcp-client:claude-ai", channel: "view", status: "pending", approved_at: "", expires_at: "2026-10-17T21:15:00Z" } } as unknown as DealBoardData;
    const a = toApproval(withApproval, "q_live_1", "pending_human", "live", { next: "Waiting for the human to tap Approve." });
    expect(ApprovalOut.safeParse(a).success).toBe(true);
    expect(a).toMatchObject({ business: "Haggle Test Seller", quote_channel: "email", amount_usd: 5, cap_usd: 5, channel: "view", status: "pending_human", approval_id: "ap_1" });
    expect(a.summary).toBe("Haggle Test Seller: $1,080 order total; pay $5 deposit now");
    expect(a.terms).toBeUndefined(); // none stated
  });

  it("approval card carries the quote's fees and terms as stated (cancellation, exclusions)", () => {
    const terms = { fees: [{ label: "Service charge", amount_usd: 90, included: false, excerpt: "18% service" }], deposit_terms: "Due on booking, non-refundable", cancellation: "Full refund until 7 days before", exclusions: ["Plates and cutlery"] };
    const withTerms = { ...live, terms: { q_live_1: terms } } as unknown as DealBoardData;
    const a = toApproval(withTerms, "q_live_1", "pending_human", "live", { next: "Waiting." });
    expect(ApprovalOut.safeParse(a).success).toBe(true);
    expect(a.terms).toEqual(terms);
  });
});

// Pure display helpers the views share (views/_shared/format.ts): no DOM needed.

describe("view display helpers", () => {
  it("custom-ask cells: money as USD, booleans yes/no, not stated as a dash", () => {
    expect(formatField(1080, "money")).toBe("$1,080");
    expect(formatField(24.5, "money")).toBe("$24.50");
    expect(formatField(true, "boolean")).toBe("Yes");
    expect(formatField(false, "boolean")).toBe("No");
    expect(formatField(null, "money")).toBe("—");
    expect(formatField(undefined, "text")).toBe("—");
    expect(formatField("2026-10-22", "date")).toBe("Thu, Oct 22");
    expect(formatField("evening only", "text")).toBe("evening only");
  });

  it("conversation kinds read as words", () => {
    expect(kindLabel("rfq")).toBe("Request for quote");
    expect(kindLabel("followup")).toBe("Follow-up");
    expect(kindLabel("counter")).toBe("Counteroffer");
    expect(kindLabel("quarantine")).toBe("Quarantined (unverified sender)");
    expect(kindLabel("approval_reply")).toBe("Approval reply");
  });

  it("tool errors: the guard's JSON becomes message + fix; anything else passes through", () => {
    const guard = new Error(JSON.stringify({ ok: false, mode: "live", error: { code: "COMMITMENT", message: "Messages can't commit to an order.", fix: "Use approve to commit." }, next: "approve" }));
    expect(parseToolError(guard)).toEqual({ code: "COMMITMENT", message: "Messages can't commit to an order.", fix: "Use approve to commit.", next: "approve" });
    expect(toolErrorText(guard)).toBe("Messages can't commit to an order. Use approve to commit.");
    expect(parseToolError(new Error("Host refused the call"))).toEqual({ message: "Host refused the call" });
    expect(parseToolError(undefined).message).toMatch(/try again/i);
  });

  it("call hours and long text", () => {
    expect(callHoursText({ start: 9, end: 18 })).toBe("9 AM – 6 PM");
    expect(callHoursText({ start: 8.5, end: 12 })).toBe("8:30 AM – 12 PM");
    expect(isLongText("short")).toBe(false);
    expect(isLongText("x".repeat(400))).toBe(true);
    expect(isLongText("a\nb\nc\nd\ne\nf\ng")).toBe(true);
  });
});
