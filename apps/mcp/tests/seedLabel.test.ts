// Seeded brain data is never called "real quotes".
import { describe, expect, it } from "vitest";
import { honestBasis, quoteCounts, seedRows } from "../src/seedLabel.ts";

const h = (job_id: string, kind = "quote") => ({ job_id, kind });

describe("seed labels", () => {
  it("counts real and seed quotes; questions don't count", () => {
    expect(quoteCounts([h("job_seed_01"), h("job_seed_02"), h("job_abc"), h("job_x", "question")])).toEqual({ real: 1, seed: 2 });
  });
  it("rewrites the brain's 'real quote' wording only when seed data is involved", () => {
    expect(honestBasis("based on 3 real quotes, $24–26 per person", { real: 0, seed: 3 })).toBe("based on 3 sample quotes (seed data, not live), $24–26 per person");
    expect(honestBasis("based on 3 real quotes", { real: 1, seed: 2 })).toBe("based on 1 real quote + 2 seed samples");
    expect(honestBasis("based on 1 real quote", { real: 1, seed: 0 })).toBe("based on 1 real quote");
  });
  it("marks the profile view's newest-first rows that came from seed data", () => {
    expect(seedRows([h("job_seed_01"), h("job_live")])).toEqual([false, true]);
  });
});
