import { describe, expect, it } from "vitest";
import { BusinessProfile, Estimate, Estimates, Hints, PriceVerdict, Business, Profile } from "@haggle/core";
import { createBrain, createStubBrain, MemoryStore, toBusinessProfileView, toEstimatesView } from "../index.ts";

const seeded = async () => {
  const brain = createBrain({ store: new MemoryStore(), seed: true, now: () => new Date("2026-10-17T12:00:00-07:00") });
  await brain.ready;
  return brain;
};

describe("brain stub", () => {
  it("returns contract-shaped data for every function", async () => {
    const stub = createStubBrain();
    const req = { what: "lunch", quantity: 25, area: "SF" };
    Profile.parse(await stub.learnFromReply("biz_x", { kind: "quote" }, { job_id: "j", business_name: "X", channel: "email", received_at: "2026-10-17T12:00:00Z", request: req }));
    for (const e of await stub.estimate(req)) Estimate.parse(e);
    PriceVerdict.parse(await stub.checkPrice({ total_usd: 995, quantity: 40 }));
    Hints.parse(await stub.negotiationHints("biz_harbor_table", req));
    expect(await stub.discover("catering", "SF", 6)).toHaveLength(6);
    Profile.parse(await stub.getProfile("Harbor Table"));
  });
});

describe("brain (seeded from fixtures/brain/seed-replies.json)", () => {
  it("answers a warm ask instantly from learned profiles, cheapest first, never the scam deli", async () => {
    const brain = await seeded();
    const estimates = await brain.estimate({ what: "Lunch for the team", quantity: 25, area: "San Francisco" });
    estimates.forEach((e) => Estimate.parse(e));
    expect(estimates.map((e) => e.business)).not.toContain("QuickQuote Deli");
    expect(estimates[0]).toMatchObject({ business: "Golden Grill" });
    const bay = estimates.find((e) => e.business === "Bay Catering")!;
    expect(bay).toMatchObject({ n_quotes: 3, best_channel: "a2a", per_unit_usd: 24.5, total_usd: 612.5 });
    expect(bay.basis).toMatch(/^based on 3 real quotes/);
    const totals = estimates.map((e) => e.total_usd);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
  });

  it("returns no estimates for a category it hasn't learned", async () => {
    const brain = await seeded();
    expect(await brain.estimate({ what: "office movers", quantity: 1, area: "SF" })).toEqual([]);
  });

  it("checks a price against real quotes in the area", async () => {
    const brain = await seeded();
    const high = await brain.checkPrice({ total_usd: 1240, quantity: 40, area: "SF", category: "catering" });
    PriceVerdict.parse(high);
    expect(high.verdict).toBe("high");
    expect(high.summary).toMatch(/% above typical for 40 people in SF$/);
    expect(high.sample_size).toBeGreaterThanOrEqual(3);

    const good = await brain.checkPrice({ total_usd: 880, quantity: 40, area: "SF" });
    expect(good.verdict).toBe("good");
  });

  it("falls back to baselines when it has no samples, and explains missing quantity", async () => {
    const brain = createBrain({ store: new MemoryStore() });
    const v = await brain.checkPrice({ total_usd: 1300, quantity: 40, area: "SF" });
    expect(v).toMatchObject({ verdict: "high", sample_size: 0, typical_per_unit_usd: 26 });
    const noQty = await brain.checkPrice({ total_usd: 1300, area: "SF" });
    expect(noQty.summary).toMatch(/Pass quantity/);
  });

  it("gives negotiation hints learned from past rounds", async () => {
    const brain = await seeded();
    const hints = Hints.parse(await brain.negotiationHints("biz_harbor_table", { what: "lunch", quantity: 40 }));
    expect(hints).toMatchObject({ expected_discount_pct: 0.1, cite_competing_quote: true, floor_per_unit_usd: 26.1 });
    expect(hints.tactics.join(" ")).toMatch(/competing quote/);

    const unknown = await brain.negotiationHints("biz_nobody", { what: "lunch" });
    expect(unknown.confidence).toBeLessThan(0.5);
  });

  it("discovers businesses with contact info and the best channel, scam last", async () => {
    const brain = await seeded();
    const found = await brain.discover("lunch catering", "SF", 6);
    found.forEach((b) => Business.parse(b));
    expect(found).toHaveLength(6);
    expect(found.find((b) => b.name === "Bay Catering")?.best_channel).toBe("a2a");
    expect(found.find((b) => b.name === "Mission Eats")?.best_channel).toBe("phone");
    expect(found.at(-1)?.name).toBe("QuickQuote Deli");
    expect(await brain.discover("catering", "Boston", 6)).toEqual([]);
  });

  it("finds profiles by id or name and renders the profile view", async () => {
    const brain = await seeded();
    const p = await brain.getProfile("harbor table");
    expect(p?.business_id).toBe("biz_harbor_table");
    const view = BusinessProfile.parse(toBusinessProfileView(p!));
    expect(view.discount_behavior).toMatch(/Drops ~10% when shown a real competing quote/);
    expect(view.deposit_rule).toBe("30% deposit, stated only in the fine print");
    expect(view.price_model).toBe("$26–29 per person");
    expect(await brain.getProfile("nope")).toBeNull();
  });

  it("learnFromReply updates what estimate says next", async () => {
    const brain = await seeded();
    await brain.learnFromReply(
      "biz_mission_eats",
      { kind: "quote", total_usd: 1080, quantity: 40 },
      { job_id: "job_demo", business_name: "Mission Eats", channel: "phone", received_at: "2026-10-17T13:09:30-07:00", request: { what: "lunch", quantity: 40, area: "SF" } },
    );
    const est = await brain.estimate({ what: "lunch", quantity: 25, area: "SF" });
    expect(est.find((e) => e.business === "Mission Eats")?.n_quotes).toBe(2);
  });

  it("estimates view says these are estimates and how to get real quotes", async () => {
    const brain = await seeded();
    const req = { what: "Lunch catering", quantity: 25, area: "SF" };
    const view = Estimates.parse(toEstimatesView(req, await brain.estimate(req)));
    expect(view.note).toMatch(/not quotes/);
    expect(view.next).toMatch(/^To get confirmed prices, call deal\(/);
    expect(toEstimatesView({ what: "movers" }, []).next).toMatch(/discover=true/);
  });
});
