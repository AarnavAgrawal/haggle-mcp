// What deal tells the agent from the brain: what businesses quoted for similar work before, always as
// estimates. A brain failure never stops a deal, and seed samples never pass for real quotes in live mode.
import { describe, expect, it } from "vitest";
import { priceContext } from "../src/priceContext.ts";

const REQUEST = { what: "lunch catering", quantity: 40, area: "San Francisco, CA" };
const estimate = (business: string, total_usd: number) => ({ business_id: business.toLowerCase().replace(/\s+/g, "_"), business, total_usd, per_unit_usd: total_usd / 40, unit: "person", confidence: 0.7, n_quotes: 3, basis: "based on 3 real quotes", best_channel: "email" as const });
const history = (job_id: string) => ({ history: [{ kind: "quote", job_id, date: "2026-10-01T00:00:00Z" }] });
const brain = (estimates: ReturnType<typeof estimate>[], jobId = "job_abc") => ({ estimate: async () => estimates, getProfile: async () => history(jobId) as never });

describe("priceContext", () => {
  it("returns what real quotes suggest, cheapest first, labelled as estimates", async () => {
    const c = await priceContext(brain([estimate("Harbor Table", 1100), estimate("Sunset Kitchen", 1300)]), REQUEST, "live");
    expect(c?.estimates.map((e) => e.business)).toEqual(["Harbor Table", "Sunset Kitchen"]);
    expect(c?.estimates[0]).toMatchObject({ total_usd: 1100, confidence: 0.7, n_quotes: 3 });
    expect(c?.note).toMatch(/estimates?.*not quotes/i);
  });

  it("keeps it compact: at most 3 businesses", async () => {
    const c = await priceContext(brain(["A", "B", "C", "D", "E"].map((n, i) => estimate(n, 1000 + i))), REQUEST, "live");
    expect(c?.estimates).toHaveLength(3);
  });

  it("has nothing to say when the brain knows nothing", async () => {
    expect(await priceContext(brain([]), REQUEST, "live")).toBeUndefined();
  });

  it("never passes seed samples off as real quotes in live mode", async () => {
    expect(await priceContext(brain([estimate("Harbor Table", 1100)], "job_seed_1"), REQUEST, "live")).toBeUndefined();
  });

  it("a brain that fails never stops the deal", async () => {
    const broken = { estimate: async () => { throw new Error("brain down"); }, getProfile: async () => null };
    await expect(priceContext(broken, REQUEST, "live")).resolves.toBeUndefined();
  });
});
