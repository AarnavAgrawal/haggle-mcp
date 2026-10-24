// What the agent is told at the decision points of a deal (buyer-experience audit, 2026-10-23):
// the pilot's manual payments never read as "payments off" or "charged", a quote held back by a
// fixable rule is still named when nothing is recommended, a cursor from another deal can't hide
// updates, and an unknown job points to list_deals.
import { describe, expect, it } from "vitest";
import { createMockEngine, fleetBusinesses, GOLDEN_REQUEST, simulatedStripe, type EngineConfig, type HaggleEngine } from "../src/index.ts";

function setup(config: Partial<EngineConfig>) {
  let t = Date.parse("2026-10-23T16:00:00Z");
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  return { ...createMockEngine({ now: clock.now, stripe: simulatedStripe(), config }), clock };
}

async function ready(engine: HaggleEngine, clock: { advance(ms: number): void }, budget_usd: number) {
  const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
  const deal = await engine.deal({ request, budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) });
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(15_000);
    cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
    const q = await engine.getQuotes(deal.job_id);
    for (const pq of q.pending_questions) await engine.answerSeller(deal.job_id, pq.question_id, "Yes, plates for 40.");
    if (q.ready && !q.pending_questions.length) return { jobId: deal.job_id, board: q, cursor };
  }
  throw new Error("did not converge");
}

describe("what the agent is told at each decision point", { timeout: 60_000 }, () => {
  it("pilot (manual payments): payments count as enabled, and nothing promises a charge", async () => {
    const { engine, clock } = setup({ globalPaymentCapCents: 1_000_000, manualPaymentHandoff: true });
    expect(engine.manualPayments).toBe(true);
    const { jobId, board } = await ready(engine, clock, 5000);
    // The board said payments were off on a manual server: the agent then told the user nothing could be bought.
    expect(board.payments_enabled).toBe(true);
    expect(board.next).not.toMatch(/PAY <code>|charges it|is charged/);
    const noDeposit = board.quotes.find((q) => q.total_usd !== null && !q.deposit_usd && q.status === "current" && q.approvable);
    expect(noDeposit).toBeDefined();
    const caveats = await engine.approvalCaveats(jobId, noDeposit!.quote_id);
    expect(caveats).toEqual(expect.arrayContaining([expect.stringMatching(/No deposit stated: the full \$[\d,.]+ is due up front \(the human pays the business directly\)/)]));
    expect(caveats.join(" ")).not.toMatch(/charged/);
  });

  it("the Stripe test rail keeps its charge wording", async () => {
    const { engine, clock } = setup({ globalPaymentCapCents: 1_000_000 });
    expect(engine.manualPayments).toBe(false);
    const { jobId, board } = await ready(engine, clock, 5000);
    const noDeposit = board.quotes.find((q) => q.total_usd !== null && !q.deposit_usd && q.status === "current" && q.approvable)!;
    expect(await engine.approvalCaveats(jobId, noDeposit.quote_id)).toEqual(expect.arrayContaining([expect.stringMatching(/is charged now/)]));
  });

  it("with nothing recommended, a cheaper quote held back by the per-payment ceiling is still named, with its fix; unsafe quotes are not", async () => {
    // $500 ceiling, $550 budget: every quote is over budget, and Golden Grill's $860 has no deposit, so all of it is due up front.
    const { engine, clock } = setup({ globalPaymentCapCents: 50_000 });
    const { board } = await ready(engine, clock, 550);
    expect(board.recommended_quote_id).toBeUndefined();
    const grill = board.quotes.find((q) => q.business === "Golden Grill" && q.status === "current")!;
    expect(grill.approvable).toBe(false);
    expect(grill.approval_block?.code).toBe("over_cap");
    for (const text of [board.recommendation_note!, board.next]) {
      expect(text).toMatch(/not approvable yet: Golden Grill \$860 \(Needs \$860 up front .*per-payment ceiling: ask Golden Grill for a smaller deposit/);
      // The pay-by-link / injection quote stays out: it isn't something to fix.
      expect(text).not.toMatch(/QuickQuote/);
    }
  });

  it("a cursor from another deal (past this deal's last event) can't hide its updates", async () => {
    const { engine, clock } = setup({ globalPaymentCapCents: 1_000_000 });
    const { jobId, cursor } = await ready(engine, clock, 5000);
    const w = await engine.waitForUpdate(jobId, cursor + 10_000, 0);
    expect(w.updates.length).toBeGreaterThan(0);
    expect(Number(w.cursor)).toBe(cursor);
    expect(w.next).toMatch(/^The cursor you passed isn't from this deal/);
    // A cursor from this deal is unaffected.
    expect((await engine.waitForUpdate(jobId, cursor, 0)).next).not.toMatch(/isn't from this deal/);
  });

  it("an unknown job points the agent to list_deals, not to starting a new deal", async () => {
    const { engine } = setup({});
    await expect(engine.getQuotes("job_nope")).rejects.toMatchObject({ code: "job_not_found", next: "list_deals" });
  });
});
