// The spending limit belongs to the deal (docs/state-and-next-fixes.md §5). Pay requires amount ≤
// approved ≤ the deal's limit ≤ the server ceiling. The deal's limit comes from the budget (or a stated
// limit), the workspace cap is only the default for a deal with no budget, the agent can only lower a
// limit, and only the human raises it (the web app's "raise it and approve"). Mock engine, fake clock,
// simulated Stripe; no network.
import { describe, expect, it } from "vitest";
import { createMockEngine, fleetBusinesses, GOLDEN_REQUEST, simulatedStripe, type HaggleEngine } from "../src/index.ts";

const { budget_usd: _b, ...request } = GOLDEN_REQUEST;
const businesses = () => fleetBusinesses().map((b) => ({ name: b.name, ...(b.email ? { email: b.email } : {}), ...(b.phone ? { phone: b.phone } : {}), simulated: true }));

function setup(globalPaymentCapCents = 500_000) {
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => { t += ms; } };
  return { ...createMockEngine({ now: clock.now, stripe: simulatedStripe(), config: { globalPaymentCapCents } }), clock };
}

async function ready(engine: HaggleEngine, clock: { advance(ms: number): void }, limits: { budget_usd?: number; spend_limit_usd?: number }) {
  const deal = await engine.deal({ request, ...limits, businesses: businesses() });
  let cursor = 0;
  for (let i = 0; i < 200; i++) {
    clock.advance(15_000);
    cursor = Number((await engine.waitForUpdate(deal.job_id, cursor, 0)).cursor);
    const q = await engine.getQuotes(deal.job_id);
    for (const pq of q.pending_questions) await engine.answerSeller(deal.job_id, pq.question_id, "Yes, plates for 40.");
    if (q.ready) return { jobId: deal.job_id, board: q };
  }
  throw new Error("did not converge");
}

/** Golden Grill quotes $860 with no deposit: approval pays the full $860 now. */
const grillOf = (board: Awaited<ReturnType<typeof ready>>["board"]) => board.quotes.find((q) => q.business === "Golden Grill")!;

describe("each deal has its own spending limit", { timeout: 60_000 }, () => {
  it("is set from the budget when the deal starts, from a stated limit, capped by the server ceiling, or left open", async () => {
    const { engine, repo } = setup(500_000);
    const fromBudget = await engine.deal({ request, budget_usd: 1200, businesses: businesses() });
    expect(await repo.getJob(fromBudget.job_id)).toMatchObject({ payment_cap_cents: 120_000, cap_set_by: "budget" });
    expect(await engine.getQuotes(fromBudget.job_id)).toMatchObject({ deal_limit_usd: 1200, deal_limit_source: "budget" });

    const stated = await engine.deal({ request, budget_usd: 1000, spend_limit_usd: 1300, businesses: businesses() });
    expect(await repo.getJob(stated.job_id)).toMatchObject({ payment_cap_cents: 130_000, cap_set_by: "agent" });

    const huge = await engine.deal({ request, budget_usd: 90_000, businesses: businesses() });
    expect((await repo.getJob(huge.job_id))!.payment_cap_cents).toBe(500_000);

    const open = await engine.deal({ request, businesses: businesses() });
    expect((await repo.getJob(open.job_id))!.payment_cap_cents).toBeNull();
    // Open until approval: the board shows the workspace default it would use.
    expect(await engine.getQuotes(open.job_id)).toMatchObject({ deal_limit_usd: 1500, deal_limit_source: "default" });

    await expect(engine.deal({ request, budget_usd: 1000, spend_limit_usd: -5, businesses: businesses() })).rejects.toMatchObject({ code: "bad_limit" });
  });

  it("pay above the deal's limit is refused (at approval, and at pay after the limit is lowered)", async () => {
    const { engine, clock } = setup();
    const { jobId, board } = await ready(engine, clock, { budget_usd: 800 });
    const grill = grillOf(board);
    await expect(engine.requestApproval(jobId, grill.quote_id, "simulated")).rejects.toMatchObject({ code: "over_deal_limit", message: expect.stringMatching(/\$860 payment is \$60 over this deal's \$800 spending limit/) });

    const second = setup();
    const r = await ready(second.engine, second.clock, { budget_usd: 1200 });
    const g = grillOf(r.board);
    const a = await second.engine.requestApproval(r.jobId, g.quote_id, "simulated");
    expect(a.cap_cents).toBe(120_000);
    await second.engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    await second.engine.setDealLimit(r.jobId, 50_000, "agent"); // lowering is always allowed
    await expect(second.engine.pay(r.jobId, g.quote_id)).rejects.toMatchObject({ code: "payment_refused_over_spend_cap" });
  });

  it("pay above the old workspace cap but within the deal's limit succeeds (the workspace cap isn't checked at payment)", async () => {
    const { engine, clock } = setup();
    await engine.updateSettings({ spending_cap_cents: 50_000 }); // $500 workspace default
    const { jobId, board } = await ready(engine, clock, { budget_usd: 1200 });
    const grill = grillOf(board);
    const a = await engine.requestApproval(jobId, grill.quote_id, "simulated");
    expect(a).toMatchObject({ payment_cents: 86_000, cap_cents: 120_000 });
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    expect(await engine.pay(jobId, grill.quote_id)).toMatchObject({ status: "settled", amount_usd: 860 });
  });

  it("a deal with no budget uses the workspace default at approval, and the approval records it", async () => {
    const { engine, clock } = setup();
    await engine.updateSettings({ spending_cap_cents: 90_000 });
    const { jobId, board } = await ready(engine, clock, {});
    const grill = grillOf(board);
    const a = await engine.requestApproval(jobId, grill.quote_id, "simulated");
    expect(a.cap_cents).toBe(90_000);
    await engine.decideApproval(a.id, "approve", "simulated", "DEMO human");
    // A later change to the default doesn't move this deal: its approval recorded the limit used.
    await engine.updateSettings({ spending_cap_cents: 10_000 });
    expect(await engine.pay(jobId, grill.quote_id)).toMatchObject({ status: "settled", amount_usd: 860 });
  });

  it("the agent can't raise a deal's limit; it may lower it; every change is audited", async () => {
    const { engine, repo } = setup();
    const deal = await engine.forWorkspace("ws_default").deal({ request, budget_usd: 1000, businesses: businesses() });
    const agent = engine.forWorkspace("ws_default");
    await expect(agent.setDealLimit(deal.job_id, 100_001)).rejects.toMatchObject({ code: "limit_increase_requires_human" });
    await expect(engine.setDealLimit(deal.job_id, 200_000, "agent")).rejects.toMatchObject({ code: "limit_increase_requires_human" });
    expect((await repo.getJob(deal.job_id))!.payment_cap_cents).toBe(100_000);
    const lowered = await agent.setDealLimit(deal.job_id, 90_000);
    expect(lowered).toMatchObject({ from_cents: 100_000, to_cents: 90_000 });
    expect(await repo.getJob(deal.job_id)).toMatchObject({ payment_cap_cents: 90_000, cap_set_by: "agent" });
    expect((await repo.getJob(deal.job_id))!.cap_set_at).toBeTruthy();
    const ev = (await repo.listEvents(deal.job_id)).filter((e) => e.type === "limit_set");
    expect(ev.map((e) => e.data)).toEqual([expect.objectContaining({ from_cents: 100_000, to_cents: 90_000, by: "agent" })]);
    // A no-budget deal: the agent can't raise above the default it would use either.
    const open = await agent.deal({ request, businesses: businesses() });
    await expect(agent.setDealLimit(open.job_id, 150_001)).rejects.toMatchObject({ code: "limit_increase_requires_human" });
  });

  it("the human can raise it at approval: one action raises the limit and approves; then pay succeeds", async () => {
    const { engine, clock, repo } = setup();
    const { jobId, board } = await ready(engine, clock, { budget_usd: 800 });
    const grill = grillOf(board);
    expect(await engine.webOverLimit("ws_default", jobId, grill.quote_id, undefined)).toMatchObject({
      over_limit: { payment_cents: 86_000, limit_cents: 80_000, over_by_cents: 6_000, ceiling_cents: 500_000 }, business: "Golden Grill",
    });
    const r = await engine.raiseLimitAndApproveByWeb("ws_default", jobId, grill.quote_id, 86_000, undefined, "ada@example.com");
    expect(r.approval).toMatchObject({ status: "approved", channel: "web", approver: "web:ada@example.com", cap_cents: 86_000, payment_cents: 86_000 });
    expect(await repo.getJob(jobId)).toMatchObject({ payment_cap_cents: 86_000, cap_set_by: "web:ada@example.com" });
    expect((await repo.listEvents(jobId)).find((e) => e.type === "limit_set")?.data).toMatchObject({ from_cents: 80_000, to_cents: 86_000, by: "web:ada@example.com" });
    expect(await engine.webOverLimit("ws_default", jobId, grill.quote_id, undefined)).toBeNull();
    expect(await engine.pay(jobId, grill.quote_id)).toMatchObject({ status: "settled", amount_usd: 860 });
  });

  it("a raise still too low approves nothing; another workspace can't raise it", async () => {
    const { engine, clock, repo } = setup();
    const { jobId, board } = await ready(engine, clock, { budget_usd: 800 });
    const grill = grillOf(board);
    await expect(engine.raiseLimitAndApproveByWeb("ws_default", jobId, grill.quote_id, 85_000, undefined, "ada@example.com")).rejects.toMatchObject({ code: "over_deal_limit" });
    expect(await repo.getLatestApproval(jobId)).toBeNull();
    await expect(engine.raiseLimitAndApproveByWeb("ws_other", jobId, grill.quote_id, 86_000, undefined, "eve@example.com")).rejects.toMatchObject({ code: "job_not_found" });
    await expect(engine.raiseLimitAndApproveByWeb("ws_default", jobId, grill.quote_id, 86_000, undefined, null)).rejects.toMatchObject({ code: "actor_required" });
  });

  it("the server ceiling still refuses: no limit above it, and no payment above it", async () => {
    const { engine, clock } = setup(80_000); // operator ceiling $800
    const { jobId, board } = await ready(engine, clock, { budget_usd: 2000 });
    const grill = grillOf(board);
    await expect(engine.setDealLimit(jobId, 86_000, "human", "ada@example.com")).rejects.toMatchObject({ code: "limit_above_ceiling" });
    await expect(engine.raiseLimitAndApproveByWeb("ws_default", jobId, grill.quote_id, 86_000, undefined, "ada@example.com")).rejects.toMatchObject({ code: "limit_above_ceiling" });
    await expect(engine.requestApproval(jobId, grill.quote_id, "simulated")).rejects.toMatchObject({ code: "over_cap" });
  });
});
