// P0 2026-10-18: every live deal failed with `jobs_max_rounds_check` (Postgres allows max_rounds 1..2;
// the live config asked for 3 since fd2e63e). Mock tests use 2, and hosted checks only dry-run, so it
// never surfaced until a real Claude.ai request. A deal must create its job whatever rounds the config
// or the agent asks for, within what the schema stores.
import { afterAll, describe, expect, it } from "vitest";
import { createMockEngine, PostgresRepository } from "../src/index.ts";

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const repos: PostgresRepository[] = [];
afterAll(async () => { await Promise.all(repos.map((r) => r.close())); });

describe.each(PG_URL ? ["memory", "postgres"] : ["memory"])("deal rounds fit the schema (%s)", (backend) => {
  it.each([[3, undefined], [3, 3], [2, undefined], [1, 1]])("config maxRounds %s, agent max_rounds %s → the job is created", async (cfg, asked) => {
    const repo = backend === "postgres" ? (repos.push(new PostgresRepository(PG_URL!, { max: 2 })), repos.at(-1)!) : undefined;
    const { engine } = createMockEngine({ config: { maxRounds: cfg }, ...(repo ? { repo } : {}) });
    const d = await engine.deal({
      request: { what: "catering", quantity: 50, unit: "people", date: "2030-10-24", area: "San Francisco", requirements: [] },
      businesses: [{ name: "Harbor Table", email: `orders-${Math.random().toString(36).slice(2)}@harbor-table.sim.haggle.dev`, simulated: true }],
      ...(asked ? { max_rounds: asked } : {}),
    });
    const job = await engine.loadJob(d.job_id);
    expect(job.max_rounds).toBeGreaterThanOrEqual(1);
    expect(job.max_rounds).toBeLessThanOrEqual(2);
  });
});
