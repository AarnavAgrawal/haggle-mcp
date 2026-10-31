import { describe, expect, it } from "vitest";
import { BusinessProfile, Estimate, Estimates, Hints, PriceVerdict, Business, Profile } from "@haggle/core";
import { createBrain, createStubBrain, createWorkspaceBrains, MemoryStore, toBusinessProfileView, toEstimatesView } from "../index.ts";

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
    expect(bay).toMatchObject({ n_quotes: 3, best_channel: "a2a", per_unit_usd: 24.5, total_usd: 613 });
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
    expect(noQty.verdict).toBe("unknown"); // can't judge, so no price_check label on the quote
  });

  it("a price far below the usual range is too_low (suspicious), not a good deal: $50 for dinner for 100", async () => {
    const cold = createBrain({ store: new MemoryStore() });
    const v = await cold.checkPrice({ total_usd: 50, quantity: 100, area: "SF", category: "dinner catering" });
    PriceVerdict.parse(v);
    expect(v).toMatchObject({ verdict: "too_low", range_per_unit_usd: { low: 18, high: 38 } });
    expect(v.summary).toMatch(/^Far below the usual \$18–38 per person/);
    // 40% of the low end is the line: $7.20 a person in SF.
    expect((await cold.checkPrice({ total_usd: 700, quantity: 100, area: "SF" })).verdict).toBe("too_low");
    expect((await cold.checkPrice({ total_usd: 740, quantity: 100, area: "SF" })).verdict).toBe("good");
    // Against learned quotes too, not only the cold-start baselines.
    const warm = await seeded();
    expect((await warm.checkPrice({ total_usd: 50, quantity: 100, area: "SF", category: "catering" })).verdict).toBe("too_low");
    expect((await createStubBrain().checkPrice({ total_usd: 50, quantity: 100 })).verdict).toBe("too_low");
  });

  it("never learns from a quote flagged implausible (or confirmed but unusual): estimates and price checks stay honest", async () => {
    const brain = createBrain({ store: new MemoryStore() });
    const meta = (job: string) => ({ job_id: job, business_name: "Lowball Co", channel: "email" as const, received_at: "2026-10-17T12:00:00Z", request: { what: "dinner catering", quantity: 100, area: "SF" } });
    for (const [i, flag] of ["price_implausible", "price_confirmed_unusual"].entries()) {
      await brain.learnFromReply("biz_lowball", { kind: "quote", total_usd: 50, quantity: 100, flags: [flag] }, meta(`j${i}`));
    }
    expect(await brain.estimate({ what: "dinner catering", quantity: 100, area: "SF" })).toEqual([]);
    const v = await brain.checkPrice({ total_usd: 2600, quantity: 100, area: "SF" });
    expect(v.sample_size).toBe(0); // still the baseline: nothing was learned from the $0.50 a person
    expect(v.verdict).toBe("typical");
  });

  it("skips a profile learned with no usable price instead of failing the estimate", async () => {
    const brain = createBrain({ store: new MemoryStore() });
    await brain.learnFromReply("biz_x", { kind: "quote", total_usd: 0 }, { job_id: "j", business_name: "X", channel: "phone", received_at: "2026-10-17T12:00:00Z", request: { what: "lunch", quantity: 40, area: "SF" } });
    const est = await brain.estimate({ what: "lunch", quantity: 40, area: "SF" });
    expect(est.every((e) => Number.isFinite(e.confidence) && e.total_usd > 0)).toBe(true);
  });

  it("recovers from a store failure at start-up instead of failing every call until restart", async () => {
    const store = new MemoryStore();
    const list = store.list.bind(store);
    let fail = true;
    store.list = async () => {
      if (fail) {
        fail = false;
        throw new Error("supabase blip");
      }
      return list();
    };
    const brain = createBrain({ store, seed: true });
    await expect(brain.ready).rejects.toThrow("supabase blip");
    expect((await brain.estimate({ what: "lunch", quantity: 40, area: "SF" })).length).toBeGreaterThan(0);
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

// ── tenancy: one brain instance per workspace over a workspace-scoped store view ──

const harborQuote = (job_id: string, total_usd: number, simulated = false) => ({
  parsed: { kind: "quote" as const, total_usd, quantity: 40, items: ["Mediterranean buffet"], confidence: 0.9 },
  meta: { job_id, business_name: "Harbor Table", channel: "email" as const, contacted_at: "2026-10-17T10:00:00Z", received_at: "2026-10-17T10:20:00Z", round: 1, request: { what: "lunch catering", quantity: 40, area: "San Francisco" }, simulated },
});

describe("workspace brains (createWorkspaceBrains)", () => {
  it("what workspace A learns never reaches workspace B: estimate, checkPrice, getProfile, hints, discover ranking", async () => {
    const brains = createWorkspaceBrains({ store: new MemoryStore() });
    const a = brains.forWorkspace("ws_alpha");
    const b = brains.forWorkspace("ws_beta");
    expect(brains.forWorkspace("ws_alpha")).toBe(a); // one instance per workspace

    // Discover ranks learned businesses first: pick one a fresh brain ranks last.
    const fresh = await createBrain({ store: new MemoryStore() }).discover("catering", "San Francisco", 6);
    const target = fresh.at(-1)!;
    for (const [i, total] of [1120, 1160, 1200].entries()) {
      const r = harborQuote(`job_alpha_${i}`, total);
      await a.learnFromReply(target.id, r.parsed, { ...r.meta, business_name: target.name });
    }

    const req = { what: "lunch catering", quantity: 40, area: "San Francisco" };
    expect((await a.estimate(req)).map((e) => e.business_id)).toEqual([target.id]);
    expect(await b.estimate(req)).toEqual([]);

    expect(await a.getProfile(target.id)).toMatchObject({ n_quotes: 3 });
    expect(await b.getProfile(target.id)).toBeNull();
    expect(await b.getProfile(target.name)).toBeNull(); // the name-scan fallback reads B's own list only

    const price = { total_usd: 1400, quantity: 40, area: "San Francisco", category: "catering" };
    expect((await a.checkPrice(price)).sample_size).toBe(3);
    expect((await b.checkPrice(price)).sample_size).toBe(0); // baseline only

    expect((await a.negotiationHints(target.id, req)).business_id).toBe(target.id);
    expect((await b.negotiationHints(target.id, req)).confidence).toBeLessThan(0.5);

    expect((await a.discover("catering", "San Francisco", 6))[0]!.id).toBe(target.id);
    expect((await b.discover("catering", "San Francisco", 6)).map((x) => x.id)).toEqual(fresh.map((x) => x.id));
  });

  it("seeding (mock) runs per workspace: each gets the samples, and learning in A leaves B's samples as they were", async () => {
    const brains = createWorkspaceBrains({ store: new MemoryStore(), seed: true });
    const a = brains.forWorkspace("ws_alpha");
    const b = brains.forWorkspace("ws_beta");
    await Promise.all([a.ready, b.ready]);
    const before = (await b.getProfile("biz_harbor_table"))!.n_quotes;
    expect((await a.getProfile("biz_harbor_table"))!.n_quotes).toBe(before);
    const r = harborQuote("job_alpha_x", 1150);
    await a.learnFromReply("biz_harbor_table", r.parsed, r.meta);
    expect((await a.getProfile("biz_harbor_table"))!.n_quotes).toBe(before + 1);
    expect((await b.getProfile("biz_harbor_table"))!.n_quotes).toBe(before);
    expect((await b.getProfile("biz_harbor_table"))!.history.map((h) => h.job_id)).not.toContain("job_alpha_x");
  });

  it("refuses an empty workspace id instead of falling back to a shared view", () => {
    expect(() => createWorkspaceBrains({ store: new MemoryStore() }).forWorkspace("")).toThrow(/workspace/);
  });
});

describe("dropSimulated (the live, observed brain)", () => {
  it("ignores a simulated reply: the profile is unchanged; a real reply still teaches it", async () => {
    const store = new MemoryStore();
    const brain = createBrain({ store, dropSimulated: true });
    const sim = harborQuote("job_sim", 900, true);
    await brain.learnFromReply("biz_harbor_table", sim.parsed, sim.meta);
    expect(await store.get("biz_harbor_table")).toBeNull();
    const real = harborQuote("job_real", 1150);
    await brain.learnFromReply("biz_harbor_table", real.parsed, real.meta);
    const learned = await store.get("biz_harbor_table");
    expect(learned?.n_quotes).toBe(1);
    await brain.learnFromReply("biz_harbor_table", sim.parsed, sim.meta);
    expect(await store.get("biz_harbor_table")).toEqual(learned);
  });

  it("without it (mock) a simulated reply still teaches the brain: the warm ask demo depends on it", async () => {
    const store = new MemoryStore();
    const sim = harborQuote("job_sim", 900, true);
    await createBrain({ store }).learnFromReply("biz_harbor_table", sim.parsed, sim.meta);
    expect((await store.get("biz_harbor_table"))?.n_quotes).toBe(1);
  });
});
