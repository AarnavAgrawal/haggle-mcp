// Guards against production mismatches that unit tests on the memory store can't see.
//
// (a) Engine config vs the Postgres CHECK constraints in supabase/migrations: a P0 outage came from
//     the live config asking for max_rounds 3 while jobs_max_rounds_check allows 1..2.
// (b) Claude structured-output schema size: Anthropic compiles each output schema into a grammar with
//     a size limit; the single QuoteExtraction schema exceeded it ("compiled grammar is too large") and
//     EVERY live parse failed until it was split into CoreExtraction + ExtractionDetails (aa688b7).
//     Each schema must stay within a byte budget ~10% above today's size: growing one past it needs a
//     live check against the API first (scripts/acceptance/extract-eval.mts, strategy-eval.mts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { createMockEngine, MAX_ROUNDS } from "../src/index.ts";
import { CoreExtraction, ExtractionDetails } from "../src/parsing/extraction.ts";
import { StrategyDecision } from "../src/negotiation/strategist.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const MIGRATIONS = readdirSync(join(ROOT, "supabase", "migrations")).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => readFileSync(join(ROOT, "supabase", "migrations", f), "utf8")).join("\n");

/** The last definition (migrations apply in order) of `<column> between A and B` / `<column> <= N`. */
function between(column: string): [number, number] {
  const all = [...MIGRATIONS.matchAll(new RegExp(`\\b${column}\\s+between\\s+(\\d+)\\s+and\\s+(\\d+)`, "gi"))];
  expect(all.length, `no CHECK on ${column}`).toBeGreaterThan(0);
  const m = all.at(-1)!;
  return [Number(m[1]), Number(m[2])];
}
function atMost(column: string, context = ""): number {
  const all = [...MIGRATIONS.matchAll(new RegExp(`${context}[^;]*?\\b${column}\\s*<=\\s*(\\d+)`, "gi"))];
  expect(all.length, `no upper bound on ${column}`).toBeGreaterThan(0);
  return Number(all.at(-1)![1]);
}

describe("engine config fits the Postgres CHECK constraints", () => {
  it("jobs.max_rounds and jobs.round hold every round the engine can reach", async () => {
    const [lo, hi] = between("max_rounds");
    expect(MAX_ROUNDS).toBeGreaterThanOrEqual(lo);
    expect(MAX_ROUNDS).toBeLessThanOrEqual(hi);
    const [, roundHi] = between("round");
    expect(MAX_ROUNDS).toBeLessThanOrEqual(roundHi); // round climbs to max_rounds while negotiating
    // Whatever the config or the agent asks for, the stored value is clamped into the CHECK.
    for (const asked of [undefined, 0, 1, 3, 99]) {
      const { engine } = createMockEngine({ config: { maxRounds: 5 } });
      const d = await engine.deal({ request: { what: "catering", quantity: 10, date: "2030-10-24", area: "SF", requirements: [] }, businesses: [{ name: "A", email: "a@sim.haggle.dev", simulated: true }], ...(asked !== undefined ? { max_rounds: asked } : {}) });
      const job = await engine.loadJob(d.job_id);
      expect(job.max_rounds).toBeGreaterThanOrEqual(lo);
      expect(job.max_rounds).toBeLessThanOrEqual(hi);
    }
  });

  it("the live per-payment ceiling fits jobs, approvals and Stripe payments", () => {
    const live = readFileSync(join(ROOT, "apps", "mcp", "src", "live.ts"), "utf8");
    const capMax = Number(/const capMax = ([\d_]+)/.exec(live)![1]!.replace(/_/g, ""));
    const capDefault = Number(/HAGGLE_GLOBAL_PAYMENT_CAP_CENTS \?\? "(\d+)"/.exec(live)![1]);
    const jobs = atMost("payment_cap_cents", "jobs_payment_cap_cents_check");
    const approvals = atMost("cap_cents", "approvals_cap_cents_check");
    const stripe = Number(/rail = 'stripe' and amount_cents <= (\d+)/.exec(MIGRATIONS)![1]);
    for (const limit of [jobs, approvals, stripe]) {
      expect(capMax).toBeLessThanOrEqual(limit);
      expect(capDefault).toBeLessThanOrEqual(limit);
    }
    // Approvals and payments require positive amounts: the engine refuses a $0 total (see noTotalQuotes.test.ts).
    expect(MIGRATIONS).toMatch(/quote_total_cents\s+integer not null check \(quote_total_cents > 0\)/);
    // A compliant quote row must carry a total: the engine stores no-total rows as not compliant.
    expect(MIGRATIONS).toMatch(/check \(not compliant or total_cents is not null\)/);
  });
});

/** Bytes of the JSON schema the SDK sends for a structured output (same conversion as parseReply / strategist). */
const schemaBytes = (s: unknown) => {
  const f = zodOutputFormat(s as never) as unknown as { schema?: unknown };
  return JSON.stringify(f.schema ?? f).length;
};

describe("structured-output schemas stay under Claude's grammar limit", () => {
  // Budgets ~10% above the sizes at 2026-10-18 (aa688b7). Don't raise them without a live API check.
  const BUDGET = { CoreExtraction: 3_600, ExtractionDetails: 1_580, StrategyDecision: 850 }; // today: 3,268 · 1,437 · 773
  it.each([["CoreExtraction", CoreExtraction], ["ExtractionDetails", ExtractionDetails], ["StrategyDecision", StrategyDecision]] as const)("%s", (name, schema) => {
    const bytes = schemaBytes(schema);
    expect(bytes).toBeLessThanOrEqual(BUDGET[name]);
  });
});
