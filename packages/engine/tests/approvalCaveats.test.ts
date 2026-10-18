// Only safety stops a purchase. Over budget, over the spending cap, a requirement the business failed
// or didn't confirm, a computed total, no deposit: the human may knowingly approve and pay, and the
// approval says exactly what they are accepting. Refused: scam links, injected instructions,
// unverified senders, a business that declined, no amount at all, or more than the operator's
// per-payment ceiling (CLAUDE.md §7: amount ≤ approved ≤ cap).
import { describe, expect, it } from "vitest";
import { createMockEngine, fleetBusinesses, GOLDEN_REQUEST, simulatedStripe, type HaggleEngine } from "../src/index.ts";

async function ready(engine: HaggleEngine, clock: { advance(ms: number): void }, opts: { budget_usd: number; extraRequirement?: boolean }) {
  const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
  const requirements = [...request.requirements, ...(opts.extraRequirement ? [{ id: "dep", kind: "other" as const, text: "Quote must include an upfront deposit", hard: true }] : [])];
  const deal = await engine.deal({ request: { ...request, requirements }, budget_usd: opts.budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) });
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    // Long enough steps to pass the reply-by deadline: a business asked to confirm an unstated
    // requirement (once) may never answer, and the deal then closes on its deadline.
    clock.advance(15_000);
    cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
    const q = await engine.getQuotes(deal.job_id);
    for (const pq of q.pending_questions) await engine.answerSeller(deal.job_id, pq.question_id, "Yes, plates for 40.");
    if (q.ready) return { deal, board: q };
  }
  throw new Error("did not converge");
}

function setup(config: Record<string, number> = { globalPaymentCapCents: 1_000_000 }) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  return { ...createMockEngine({ now: clock.now, stripe: simulatedStripe(), config }), clock };
}

describe("only safety stops a purchase; everything else is a caveat", { timeout: 60_000 }, () => {
  it("over budget: approvable and payable, and the approval says by how much", async () => {
    const { engine, clock } = setup();
    const { deal, board } = await ready(engine, clock, { budget_usd: 1000 });
    expect(board.job.state).not.toBe("failed");
    const sunset = board.quotes.find((q) => q.business === "Sunset Kitchen")!;
    expect(sunset.flags).toContain("over_budget");
    expect(await engine.approvalCaveats(deal.job_id, sunset.quote_id)).toEqual(expect.arrayContaining([expect.stringMatching(/^\$180(\.00)? over the \$1,000(\.00)? budget/)]));
    const a = await engine.requestApproval(deal.job_id, sunset.quote_id, "simulated");
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    expect(await engine.pay(deal.job_id, sunset.quote_id)).toMatchObject({ status: "settled" });
  });

  it("a requirement the business failed or didn't confirm is a caveat, not a refusal; no deposit pays the full total", async () => {
    const { engine, clock } = setup();
    const { deal, board } = await ready(engine, clock, { budget_usd: 1200, extraRequirement: true });
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    expect(await engine.approvalCaveats(deal.job_id, bay.quote_id)).toContain("Not confirmed by the business: Quote must include an upfront deposit");

    const grill = board.quotes.find((q) => q.business === "Golden Grill")!; // only 6 of 12 vegetarian, no deposit
    const caveats = await engine.approvalCaveats(deal.job_id, grill.quote_id);
    expect(caveats).toEqual(expect.arrayContaining([expect.stringMatching(/^Doesn't meet: At least 12 vegetarian meals \(only 6 of 12\)/), expect.stringMatching(/^No deposit stated: the full \$860/)]));
    const a = await engine.requestApproval(deal.job_id, grill.quote_id, "simulated");
    expect(a.payment_cents).toBe(86_000);
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    expect(await engine.pay(deal.job_id, grill.quote_id)).toMatchObject({ status: "settled", amount_usd: 860 });
  });

  it("the settings spending cap is a caveat; the operator's per-payment ceiling is the only money limit", async () => {
    const { engine, clock } = setup({ globalPaymentCapCents: 1_000_000 });
    await engine.updateSettings({ spending_cap_cents: 50_000 }); // $500
    const { deal, board } = await ready(engine, clock, { budget_usd: 1200 });
    const harbor = board.quotes.find((q) => q.business === "Harbor Table")!;
    expect(await engine.approvalCaveats(deal.job_id, harbor.quote_id)).toEqual(expect.arrayContaining([expect.stringMatching(/over your \$500 spending cap/)]));
    expect((await engine.requestApproval(deal.job_id, harbor.quote_id, "simulated")).status).toBe("pending");

    const small = setup({ globalPaymentCapCents: 10_000 }); // operator ceiling $100
    const r2 = await ready(small.engine, small.clock, { budget_usd: 1200 });
    const h2 = r2.board.quotes.find((q) => q.business === "Harbor Table")!; // $300 deposit
    await expect(small.engine.requestApproval(r2.deal.job_id, h2.quote_id, "simulated")).rejects.toMatchObject({ code: "over_cap" });
  });

  it("safety still refuses: the pay-now scam with injected instructions", async () => {
    const { engine, clock } = setup();
    const { deal, board } = await ready(engine, clock, { budget_usd: 1200 });
    const deli = board.quotes.find((q) => q.business === "QuickQuote Deli")!;
    expect(deli.verdict).toBe("rejected");
    await expect(engine.requestApproval(deal.job_id, deli.quote_id, "simulated")).rejects.toMatchObject({ code: "quote_not_eligible" });
    // Non-safety problems are flagged, never shown as rejected.
    expect(board.quotes.find((q) => q.business === "Golden Grill")!.verdict).not.toBe("rejected");
  });
});
