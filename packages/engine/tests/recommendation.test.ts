// The recommendation must be a quote the human can actually approve (acceptance P1): with no hard
// requirements, Golden Grill wins on value at $860 with NO deposit, so approving it would charge the
// full $860, above the mock per-payment ceiling ($500); requestApproval refuses (over_cap). The board
// keeps Golden Grill visible with that reason and recommends (and points `next` at) the best quote
// that can be approved. The ceiling is never weakened. And (P3) after a deal is paid, approve says so.
import { describe, expect, it } from "vitest";
import { createMockEngine, fleetBusinesses, GOLDEN_REQUEST, simulatedStripe, type HaggleEngine } from "../src/index.ts";

async function ready(engine: HaggleEngine, clock: { advance(ms: number): void }) {
  const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
  const deal = await engine.deal({ request: { ...request, requirements: [] }, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) });
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(15_000);
    cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
    const q = await engine.getQuotes(deal.job_id);
    for (const pq of q.pending_questions) await engine.answerSeller(deal.job_id, pq.question_id, "Yes, plates for 40.");
    if (q.ready && q.pending_questions.length === 0) return { deal, board: q };
  }
  throw new Error("did not converge");
}

function setup() {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  return { ...createMockEngine({ now: clock.now, stripe: simulatedStripe() }), clock }; // mock ceiling: $500 per payment
}

describe("recommend only what can be approved", { timeout: 60_000 }, () => {
  it("best value over the per-payment ceiling stays visible with its reason; next points at the best approvable quote", async () => {
    const { engine, clock } = setup();
    const { deal, board } = await ready(engine, clock);
    const grill = board.quotes.find((q) => q.business === "Golden Grill" && q.status === "current")!;
    expect(grill).toMatchObject({ total_usd: 860, approvable: false, approval_block: { code: "over_cap" } });
    expect(grill.deposit_usd).toBeUndefined();
    expect(grill.approval_block!.reason).toMatch(/^Needs \$860 up front \(no deposit stated, so the full total\), above the \$500 per-payment ceiling: ask Golden Grill for a smaller deposit, or ask the operator to raise the ceiling\.$/);
    // Golden Grill is the best value, but not recommended; the recommendation can be approved.
    expect(board.value!.recommendedQuoteId).toBe(grill.quote_id);
    expect(board.best_value_quote_id).toBe(grill.quote_id);
    const rec = board.quotes.find((q) => q.quote_id === board.recommended_quote_id)!;
    expect(rec.approvable).toBe(true);
    expect(rec.business).not.toBe("Golden Grill");
    expect(board.recommendation_note).toMatch(/^Best value is Golden Grill but it can't be approved yet: Needs \$860 up front.* Recommended instead: /);
    expect(board.next).toContain(`quote_id='${rec.quote_id}'`);
    expect(board.next).not.toContain(grill.quote_id);
    // The ceiling holds; the recommended quote really is approvable.
    await expect(engine.requestApproval(deal.job_id, grill.quote_id, "simulated")).rejects.toMatchObject({ code: "over_cap" });
    const a = await engine.requestApproval(deal.job_id, rec.quote_id, "simulated");
    expect(a.payment_cents).toBeLessThanOrEqual(50_000);

    // P3: once paid, approve says the deal is closed (not "wait until quotes are in").
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    await engine.pay(deal.job_id, rec.quote_id);
    expect((await engine.loadJob(deal.job_id)).state).toBe("paid");
    const err = await engine.requestApproval(deal.job_id, rec.quote_id, "simulated").catch((e) => e);
    expect(err).toMatchObject({ code: "not_approvable", next: "deal" });
    expect(err.fix).toMatch(/already paid and closed/);
  });

  it("when nothing can be approved, next says so and why", async () => {
    let t = Date.now();
    const { engine } = createMockEngine({ now: () => new Date(t), stripe: simulatedStripe(), config: { globalPaymentCapCents: 100 } }); // $1 ceiling: nothing fits
    const clock = { advance: (ms: number) => { t += ms; } };
    const { board } = await ready(engine, clock);
    expect(board.recommended_quote_id).toBeUndefined();
    expect(board.recommendation_note).toMatch(/No quote can be approved yet\.$/);
    expect(board.next).toMatch(/^Quotes are final, but none can be approved yet: .*per-payment ceiling/);
  });

  it("a cancelled deal: approve says it was cancelled", async () => {
    const { engine } = setup();
    const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
    const deal = await engine.deal({ request, businesses: [{ name: "Golden Grill", email: "sales@golden-grill.sim.haggle.dev", simulated: true }] });
    await engine.cancel(deal.job_id);
    await expect(engine.requestApproval(deal.job_id, "q_x", "simulated")).rejects.toMatchObject({ code: "not_approvable", fix: expect.stringMatching(/cancelled/) });
  });
});
