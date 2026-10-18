// The human can knowingly approve a quote that is over budget, or whose requirement Haggle couldn't
// confirm; the approval says so. Safety refusals (a requirement the business failed, scam links,
// injected instructions, unverified senders, no total) stay hard.
import { describe, expect, it } from "vitest";
import { createMockEngine, fleetBusinesses, GOLDEN_REQUEST, simulatedStripe, type HaggleEngine } from "../src/index.ts";

async function ready(engine: HaggleEngine, clock: { advance(ms: number): void }, opts: { budget_usd: number; extraRequirement?: boolean }) {
  const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
  const requirements = [...request.requirements, ...(opts.extraRequirement ? [{ id: "dep", kind: "other" as const, text: "Quote must include an upfront deposit", hard: true }] : [])];
  const deal = await engine.deal({ request: { ...request, requirements }, budget_usd: opts.budget_usd, businesses: fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true })) });
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(1_000);
    cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
    const q = await engine.getQuotes(deal.job_id);
    for (const pq of q.pending_questions) await engine.answerSeller(deal.job_id, pq.question_id, "Yes, plates for 40.");
    if (q.ready) return { deal, board: q };
  }
  throw new Error("did not converge");
}

function setup() {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  return { ...createMockEngine({ now: clock.now, stripe: simulatedStripe() }), clock };
}

describe("approving with caveats", { timeout: 60_000 }, () => {
  it("over budget: approvable, and the approval says by how much", async () => {
    const { engine, clock } = setup();
    const { deal, board } = await ready(engine, clock, { budget_usd: 1000 });
    const sunset = board.quotes.find((q) => q.business === "Sunset Kitchen")!;
    expect(sunset.flags).toContain("over_budget");
    const caveats = await engine.approvalCaveats(deal.job_id, sunset.quote_id);
    expect(caveats).toEqual([expect.stringMatching(/^\$180(\.00)? over the \$1,000(\.00)? budget/)]);
    const a = await engine.requestApproval(deal.job_id, sunset.quote_id, "simulated");
    expect(a.status).toBe("pending");
  });

  it("a requirement Haggle couldn't confirm: approvable with a caveat; one the business failed: still refused", async () => {
    const { engine, clock } = setup();
    const { deal, board } = await ready(engine, clock, { budget_usd: 1200, extraRequirement: true });
    expect(board.recommended_quote_id).toBeUndefined(); // nothing is recommended while unconfirmed
    const bay = board.quotes.find((q) => q.business === "Bay Catering")!;
    expect(await engine.approvalCaveats(deal.job_id, bay.quote_id)).toEqual(["Not confirmed by the business: Quote must include an upfront deposit"]);
    expect((await engine.requestApproval(deal.job_id, bay.quote_id, "simulated")).status).toBe("pending");

    const { engine: e2, clock: c2 } = setup();
    const r2 = await ready(e2, c2, { budget_usd: 1200, extraRequirement: true });
    for (const name of ["Golden Grill", "QuickQuote Deli"]) { // only 6 of 12 vegetarian; pay-now link + injection
      const q = r2.board.quotes.find((x) => x.business === name)!;
      await expect(e2.requestApproval(r2.deal.job_id, q.quote_id, "simulated")).rejects.toMatchObject({ code: "quote_not_eligible" });
    }
  });
});
