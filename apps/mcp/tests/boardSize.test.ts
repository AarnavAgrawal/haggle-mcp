// get_quotes output size (sprint 4, E): the golden six-quote board (mock fleet, SIMULATED) stays under
// BOARD_CHAR_BUDGET, and the compact board keeps everything the deal-board view renders and every
// decision-critical fact (totals, deposits, flags, approvability reasons, non-compliance, confidence).
import { describe, expect, it } from "vitest";
import { DealBoard } from "@haggle/core";
import type { DealBoardData } from "@haggle/engine";
import { createMockEngine } from "../../../packages/engine/src/mock.ts";
import { fleetBusinesses, GOLDEN_REQUEST } from "../../../packages/engine/src/sim/fleet.ts";
import { BOARD_CHAR_BUDGET, compactBoard, DealBoardPlus, toDealBoardPlus } from "../src/views.ts";

async function goldenBoard(readLaterMs = 0): Promise<DealBoardData> {
  let t = Date.parse("2026-10-20T16:00:00Z");
  const { engine } = createMockEngine({ now: () => new Date(t) });
  const { budget_usd, ...request } = GOLDEN_REQUEST;
  const d = await engine.deal({ request: { ...request, date: "2026-10-29" }, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), ...(b.a2a_card_url ? { a2a_card_url: b.a2a_card_url } : {}), source: "fleet" as const, simulated: true })) });
  let b = await engine.getQuotes(d.job_id);
  for (let i = 0; i < 200 && !b.ready; i++) {
    t += 5_000;
    await engine.waitForUpdate(d.job_id, 0, 0);
    b = await engine.getQuotes(d.job_id);
    for (const q of b.open_questions) await engine.answerSeller(d.job_id, q.question_id, "Yes please, plates and cutlery for 40.");
  }
  if (readLaterMs) { t += readLaterMs; b = await engine.getQuotes(d.job_id); }
  return b;
}

describe("get_quotes size budget (simulated golden fleet)", { timeout: 60_000 }, () => {
  it("six quotes fit the budget; detail: true is the larger full board", async () => {
    const b = await goldenBoard();
    expect(b.ready).toBe(true);
    const compact = toDealBoardPlus(b, "mock");
    const full = toDealBoardPlus(b, "mock", {}, { detail: true });
    expect(compact.quotes).toHaveLength(6);
    const size = JSON.stringify(compact).length;
    expect(size, `compact board is ${size} chars`).toBeLessThanOrEqual(BOARD_CHAR_BUDGET);
    expect(JSON.stringify(full).length).toBeGreaterThan(size * 1.3);
    expect(compact.compact).toBe(true);
    expect(full.compact).toBeUndefined();
    // Both are valid outputs of the tool and of the shared view schema.
    expect(DealBoardPlus.safeParse(compact).success).toBe(true);
    expect(DealBoard.safeParse({ ...compact, quotes: compact.quotes.map((q) => ({ ...q, total_usd: q.total_usd ?? 0 })) }).success).toBe(true);
  });

  it("a board read after the quotes went stale (every quote needs re-confirmation) still fits", async () => {
    const b = await goldenBoard(3 * 86_400_000);
    const c = toDealBoardPlus(b, "mock");
    expect(Object.keys(c.freshness ?? {}).length).toBeGreaterThan(0);
    for (const [id, f] of Object.entries(toDealBoardPlus(b, "mock", {}, { detail: true }).freshness ?? {})) {
      expect(c.freshness![id]).toMatchObject({ stale: f.stale, good_until: f.good_until });
      expect(c.freshness![id]!.valid_until ?? c.quotes.find((q) => q.quote_id === id)?.valid_until).toBe(f.valid_until);
    }
    const size = JSON.stringify(c).length;
    expect(size, `stale compact board is ${size} chars`).toBeLessThanOrEqual(BOARD_CHAR_BUDGET);
  });

  it("keeps what the view renders and every decision-critical fact", async () => {
    const b = await goldenBoard();
    const c = toDealBoardPlus(b, "mock");
    const f = toDealBoardPlus(b, "mock", {}, { detail: true });
    // Every quote row: totals, deposits, flags, confidence, verdict and eligibility unchanged.
    for (const q of f.quotes) {
      const k = c.quotes.find((x) => x.quote_id === q.quote_id)!;
      for (const key of ["total_usd", "deposit_usd", "per_unit_usd", "delivery_usd", "tax_usd", "flags", "confidence", "verdict", "eligible", "meets_requirements", "negotiated_from", "items", "source", "valid_until"] as const) expect(k[key], `${q.business} ${key}`).toEqual(q[key]);
      expect(k).not.toHaveProperty("message_id");
    }
    // Approvability and its reason (server verdict the view obeys), and every non-compliance.
    expect(c.quote_status).toEqual(f.quote_status);
    for (const [id, x] of Object.entries(f.compliance ?? {})) if (x.status !== "compliant" || x.assumed.length || x.issues.length) expect(c.compliance?.[id], id).toEqual(x);
    expect(Object.values(c.compliance ?? {}).some((x) => x.status === "noncompliant")).toBe(true);
    // The recommendation's factors (the board's "why"), every other quote's why-not and score.
    const rec = c.value!.ranked.find((r) => r.quoteId === c.recommended_quote_id)!;
    expect(rec.factors).toEqual(f.value!.ranked.find((r) => r.quoteId === c.recommended_quote_id)!.factors.filter((x) => x.weight > 0).map((x) => ({ name: x.name, score: x.score, weight: x.weight, neutral: x.neutral, note: x.note })));
    expect(c.value!.explanation!.winner).toBe(f.value!.explanation!.winner);
    for (const o of f.value!.explanation!.others) {
      const k = c.value!.explanation!.others.find((x) => x.quote_id === o.quote_id)!;
      // The view strips "<name>: " and "$X (…), value a vs b; " and shows the rest: same words either way.
      const shown = (t: string) => t.replace(/^[^:]+:\s*/, "").replace(/^\$[\d,.]+(\s*\([^)]*\))?,\s*value [\d.]+ vs [\d.]+;\s*/, "");
      expect(shown(k.text)).toBe(shown(o.text));
      const score = f.value!.ranked.find((r) => r.quoteId === o.quote_id)?.score;
      if (score !== undefined) expect(k.text).toContain(score.toFixed(2));
    }
    // Negotiation trail, stages the view reads, rejected reasons, request details.
    expect(c.negotiation).toEqual(f.negotiation);
    expect(c.rejected).toEqual(f.rejected);
    for (const [id, s] of Object.entries(f.stages ?? {})) {
      expect(c.stages![id]).toMatchObject({ stage: s.stage, negotiation: s.negotiation, first_total_usd: s.first_total_usd, ...(s.saved_usd ? { saved_usd: s.saved_usd } : {}) });
      if (s.current_total_usd !== s.first_total_usd) expect(c.stages![id]!.current_total_usd).toBe(s.current_total_usd);
    }
    expect(c.request_details).toMatchObject({ what: f.request_details!.what, when: f.request_details!.when, place: f.request_details!.place, requirements: f.request_details!.requirements, budget_usd: f.request_details!.budget_usd });
    // The vendor's words: still shown (one line), still absent for unsafe replies.
    for (const x of f.businesses) {
      const k = c.businesses.find((y) => y.id === x.id)!;
      expect(k.status).toBe(x.status);
      if (x.transcript_snippet) expect(x.transcript_snippet.startsWith(k.transcript_snippet!.replace(/…$/, ""))).toBe(true);
      else expect(k.transcript_snippet).toBeUndefined();
    }
  });

  it("compaction is lossless for fees, exclusions, assumptions and stale quotes", () => {
    const base = { job: { id: "job_x", request: "lunch", state: "collecting", requirements: [] }, empty: false, businesses: [], quotes: [], open_questions: [], next: "n", mode: "live" } as unknown as DealBoardPlus;
    const terms = { q1: { fees: [{ label: "service charge", amount_usd: 180, included: false, excerpt: "plus an 18% service charge" }], exclusions: ["rentals"], deposit_terms: "50% at booking", cancellation: null } };
    const compliance = { q1: { status: "unconfirmed" as const, issues: [], assumed: ["delivery assumed included"] }, q2: { status: "compliant" as const, issues: [], assumed: [] } };
    const freshness = { q1: { stale: true, good_until: "2026-10-21T00:00:00Z", valid_until: null } };
    const out = compactBoard({ ...base, terms, compliance, freshness });
    expect(out.terms).toEqual(terms);
    expect(out.freshness).toEqual(freshness);
    expect(out.compliance).toEqual({ q1: compliance.q1 }); // a plainly compliant quote is implied
  });

  it("integration slots for vendor contact status (A) and selection reasons (B) pass through", async () => {
    const b = await goldenBoard();
    const q = b.quotes[0]!;
    const withSlots = { ...b, vendor_contact: { [q.business_id]: { status: "delivered", detail: "RFQ delivered 09:02" } }, selection: { [q.quote_id]: { outcome: "selected", reason: "cheapest compliant" } } } as DealBoardData;
    const out = toDealBoardPlus(withSlots, "mock");
    expect(out.vendor_contact).toEqual({ [q.business_id]: { status: "delivered", detail: "RFQ delivered 09:02" } });
    expect(out.selection).toEqual({ [q.quote_id]: { outcome: "selected", reason: "cheapest compliant" } });
    expect(toDealBoardPlus(b, "mock")).not.toHaveProperty("vendor_contact");
  });
});
