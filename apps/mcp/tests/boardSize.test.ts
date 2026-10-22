// get_quotes output size (sprint 4, E): the golden six-quote board (mock fleet, SIMULATED) stays under
// BOARD_CHAR_BUDGET, and the compact board keeps everything the deal-board view renders and every
// decision-critical fact (totals, deposits, flags, approvability reasons, non-compliance, confidence).
import { describe, expect, it } from "vitest";
import { DealBoard } from "@haggle/core";
import type { DealBoardData } from "@haggle/engine";
import { createMockEngine } from "../../../packages/engine/src/mock.ts";
import { fleetBusinesses, GOLDEN_REQUEST } from "../../../packages/engine/src/sim/fleet.ts";
import { BOARD_CHAR_BUDGET, compactBoard, DealBoardPlus, toDealBoardPlus, waitOutput } from "../src/views.ts";

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
    // Past the 7-day validity window and the fleet's own valid-until (14 days from the quote, sim/fleet.ts).
    const b = await goldenBoard(15 * 86_400_000);
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
    // (an empty `assumed` list is left out of the compact board: absent = nothing assumed)
    for (const [id, x] of Object.entries(f.compliance ?? {})) if (x.status !== "compliant" || x.assumed?.length || x.issues.length) expect(c.compliance?.[id], id).toEqual(x.assumed?.length ? x : { status: x.status, issues: x.issues });
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
    // vendor_contact comes from the engine read model; selection from each current quote's `selection` (S4-B).
    const withSlots = { ...b, vendor_contact: { [q.business_id]: { status: "bounced", detail: "email bounced" } }, quotes: b.quotes.map((x, i) => (i === 0 ? { ...x, status: "current", selection: { status: "not_selectable", reason: "doesn't meet: 12 vegetarian" } } : x)) } as DealBoardData;
    const out = toDealBoardPlus(withSlots, "mock");
    expect(out.vendor_contact).toEqual({ [q.business_id]: { status: "bounced", detail: "email bounced" } });
    expect(out.selection?.[q.quote_id]).toEqual({ status: "not_selectable", reason: "doesn't meet: 12 vegetarian" });
    expect(toDealBoardPlus(b, "mock")).not.toHaveProperty("vendor_contact");
  });

  // Sprint 5 (E): measured on the pilot benchmark (scripts/pilot-benchmark.ts, seed 1): a busy
  // workspace's six-vendor board carried restated reasons and derivable history fields.
  it("restated selection reasons, derivable contact statistics and empty assumption lists are left out of the compact board", () => {
    const base = { job: { id: "job_x", request: "lunch", state: "negotiating", requirements: [] }, empty: false, businesses: [], quotes: [], open_questions: [], next: "n", mode: "mock",
      rejected: [{ business_id: "biz_q", quote_id: "q_inj", reason: "external_payment_link", detail: "asked for payment through an external link (blocked)" }] } as unknown as DealBoardPlus;
    const block = { code: "over_cap", reason: "Needs $860 up front (no deposit stated, so the full total), above the $500 per-payment ceiling: ask Golden Grill for a smaller deposit, or ask the operator to raise the ceiling." };
    const out = compactBoard({
      ...base,
      quote_status: { q_cap: { approvable: false, block }, q_ok: { approvable: true }, q_inj: { approvable: false, block: { code: "quote_not_eligible", reason: "It asked for payment through an external link (blocked)." } } },
      selection: {
        q_cap: { status: "not_selectable", reason: "can't be approved yet: Needs $860 up front (no deposit stated, so the full tota…" },
        q_inj: { status: "not_selectable", reason: "can't win: asked for payment through an external link (blocked)" },
        q_stale: { status: "not_selectable", reason: "stale: past its valid-until date (2026-10-21)" },
        q_rec: { status: "recommended", reason: "recommended: meets every requirement and the budget, fresh, best value of the quotes that can be approved" },
      },
      contact_learning: { biz_a: { channels: { email: { contacted_jobs: 6, replied_jobs: 5, quotes: 12, response_rate: 0.83, confidence: 0.67, median_reply_minutes: 4 } } } },
      compliance: { q_cap: { status: "noncompliant", issues: [{ code: "over_budget", text: "$310 over the $550 budget" }], assumed: [] }, q_u: { status: "unconfirmed", issues: [], assumed: ["delivery assumed included"] } },
    });
    // The two not_selectable reasons restate quote_status.block / rejected[].detail word for word: gone. Others stay.
    expect(Object.keys(out.selection ?? {}).sort()).toEqual(["q_rec", "q_stale"]);
    // Past replies keep what the view shows (n replied of n contacted, reply time); the rate is replied/contacted.
    expect(out.contact_learning).toEqual({ biz_a: { channels: { email: { contacted_jobs: 6, replied_jobs: 5, median_reply_minutes: 4 } } } });
    expect(out.compliance).toEqual({ q_cap: { status: "noncompliant", issues: [{ code: "over_budget", text: "$310 over the $550 budget" }] }, q_u: { status: "unconfirmed", issues: [], assumed: ["delivery assumed included"] } });
    expect(DealBoardPlus.safeParse(out).success).toBe(true);
  });

  it("wait_for_update: a poll that saw nothing new says so in one short hint; anything new keeps the engine's hint", () => {
    const w = { ok: true as const, mode: "mock" as const, job_id: "job_x", state: "collecting", cursor: "27", updates: [], timed_out: true, next: "Still collecting: waiting for Bay Catering; quotes close as soon as every business has answered, at 16:10 UTC at the latest. Call wait_for_update again (cursor from this response)." };
    const quiet = waitOutput(w, 27, { until: "any_change", timeoutS: 25 });
    expect(quiet.structured).toEqual({ ...w, next: "Nothing new since cursor 27; the previous hint stands. Wait again with this cursor." });
    expect(JSON.stringify(quiet.structured).length).toBeLessThan(JSON.stringify(w).length - 80);
    expect(quiet.text).toBe(`No change in 25s (collecting).\ncursor=27 · next: ${quiet.structured.next}`);
    // First poll of a session (cursor 0), or any update: the engine's full hint.
    expect(waitOutput({ ...w, cursor: "0" }, 0, { until: "any_change", timeoutS: 25 }).structured.next).toBe(w.next);
    const moved = waitOutput({ ...w, cursor: "28", timed_out: false, updates: [{ type: "state", from: "collecting", to: "negotiating" }] as never }, 27, { until: "any_change", timeoutS: 25 });
    expect(moved.structured.next).toBe(w.next);
    // At most the 12 newest updates; updates_omitted counts the rest.
    const many = waitOutput({ ...w, timed_out: false, cursor: "60", updates: Array.from({ length: 15 }, (_, i) => ({ type: "reply", business_id: "b", summary: `u${i}` })) as never }, 27, { until: "any_change", timeoutS: 25 });
    expect(many.structured.updates).toHaveLength(12);
    expect(many.structured).toMatchObject({ updates_omitted: 3 });
  });
});
