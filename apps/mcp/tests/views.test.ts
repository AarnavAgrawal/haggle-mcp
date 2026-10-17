// Engine read model -> shared view schemas. Shaped like the live round trip of 2026-10-17
// (job_512a5d0265b144ed9337: one email seller outside the directory quoted $1,080), so the deal
// board that rendered live in Claude.ai keeps rendering through the shared DealBoard schema.
import { describe, expect, it } from "vitest";
import type { DealBoardData } from "@haggle/engine";
import { ApprovalOut, DealBoard, DealBoardOrEmpty, emptyBoard, toApproval, toDealBoard } from "../src/views.ts";

const request = {
  what: "lunch catering", quantity: 40, unit: "people", date: "2026-10-22", area: "San Francisco, CA", budget_usd: 1200,
  requirements: [{ id: "veg12", kind: "dietary" as const, text: "At least 12 vegetarian meals", hard: true, min_count: 12 }],
};

const quote = {
  kind: "quote" as const, quote_id: "q_live_1", job_id: "job_512a5d0265b144ed9337", business_id: "biz_3f1c0a9e5b7d2c41", business: "Haggle Test Seller",
  channel: "email" as const, total_usd: 1080, deposit_usd: 5, items: ["Lunch buffet for 40 (14 vegetarian)"], meets_requirements: true,
  requirement_results: [{ requirement_id: "veg12", met: true }], missing: [], flags: [], round: 1, confidence: 0.92, source: "email body",
  evidence: { total_usd: { provenance: "stated" as const, source: "email body" } }, status: "current" as const, message_id: "msg_live_1",
  eligible: true, verdict: "compliant" as const,
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
    expect(b.job.request).toBe("lunch catering for 40 people · 2026-10-22 · San Francisco, CA");
    expect(b.quotes).toHaveLength(1); // D2: the reply with no total is not a quote
    expect(b.quotes[0]).toMatchObject({ business: "Haggle Test Seller", channel: "email", total_usd: 1080, eligible: true, verdict: "compliant" });
    expect(b.quotes[0]).not.toHaveProperty("evidence"); // engine-internal fields never reach the view
    expect(b.businesses.find((x) => x.name === "Golden Grill")).toMatchObject({ status: "contacted", last_event: "Contacted" });
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
  });
});
