// Sprint 5 (E): the SIMULATED pilot benchmark (scripts/pilot-benchmark.ts) on a small N. It must be
// reproducible (same seed, same fingerprint), keep every run in the simulated bucket of the metrics
// rule, stay inside the board budget, and refuse a non-local database for --repo pg.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchmarkMarkdown, deterministicView, planBenchmark, prng, runPilotBenchmark, scenario } from "../scripts/pilot-benchmark.ts";
import { BOARD_CHAR_BUDGET } from "../src/views.ts";

describe("pilot benchmark (SIMULATED)", { timeout: 120_000 }, () => {
  it("is deterministic for a seed and labels itself simulated", async () => {
    const a = await runPilotBenchmark({ n: 2, seed: 3 });
    const b = await runPilotBenchmark({ n: 2, seed: 3 });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(deterministicView(a)).toEqual(deterministicView(b));
    expect((await runPilotBenchmark({ n: 2, seed: 4 })).fingerprint).not.toBe(a.fingerprint);
    expect(a.label).toMatch(/^SIMULATED/);
    expect(benchmarkMarkdown(a)).toMatch(/^# Pilot benchmark: SIMULATED .*not real-world evidence/);
  });

  it("records tool calls, human steps, output size, simulated timings, outcome and AI cost per deal", async () => {
    const r = await runPilotBenchmark({ n: 3, seed: 1 });
    expect(r.deals).toHaveLength(3);
    for (const d of r.deals) {
      expect(d.tool_calls).toBe(d.calls.length);
      expect(d.calls[0]!.tool).toBe("deal");
      expect(d.calls.some((c) => c.tool === "get_quotes")).toBe(true);
      expect(d.output_chars).toBe(d.calls.reduce((n, c) => n + c.chars, 0));
      expect(d.outcome).toBeTruthy();
      // The board every agent reads stays within the budget the tools promise.
      expect(d.by_tool.get_quotes!.max_chars).toBeLessThanOrEqual(BOARD_CHAR_BUDGET);
      if (d.outcome === "paid") expect(d.human_steps.at(-1)).toMatch(/approves/);
    }
    expect(Object.keys(r.summary.outcomes)).toContain("paid");
    // The metrics rule puts every benchmark job in the simulated bucket (mock mode).
    expect(r.summary.metrics).toMatchObject({ real_jobs: 0, simulated_jobs: 3, simulated_reasons: { mock_mode: 3 } });
    // Mock mode makes no Claude calls; the live projection is labelled an assumption.
    expect(r.summary.ai).toMatchObject({ recorded_calls: 0, recorded_approx_usd: 0 });
    expect(r.summary.ai.projected_live_ai.approx_usd).toBeGreaterThan(0);
  });

  it("scenarios come from a seeded PRNG: pure and within the catering pilot's shape", () => {
    expect(prng(5)()).toBe(prng(5)());
    expect(scenario(1, 0)).toEqual(scenario(1, 0));
    for (let i = 0; i < 20; i++) {
      const s = scenario(9, i);
      expect(s.vendors.length).toBeGreaterThanOrEqual(3);
      expect(new Set(s.vendors.map((v) => v.name)).size).toBe(s.vendors.length);
      expect(Date.parse(s.date)).toBeGreaterThan(Date.parse("2026-10-07"));
    }
  });

  it("validates arguments and never writes mock data to a non-local database", async () => {
    expect(planBenchmark([])).toEqual({ n: 10, seed: 1, repo: "memory", json: false });
    expect(() => planBenchmark(["--n", "0"])).toThrow(/1-500/);
    expect(() => planBenchmark(["--repo", "live"])).toThrow(/memory or pg/);
    expect(() => planBenchmark(["--live"])).toThrow(/unknown option/);
    await expect(runPilotBenchmark({ n: 1, seed: 1, repo: "pg" })).rejects.toThrow(/HAGGLE_BENCH_DATABASE_URL/);
    await expect(runPilotBenchmark({ n: 1, seed: 1, repo: "pg", databaseUrl: "postgres://u:p@db.example.supabase.co:5432/postgres" })).rejects.toThrow(/localhost/);
  });

  it("runs under plain node", () => {
    const r = spawnSync(process.execPath, ["scripts/pilot-benchmark.ts", "--n", "1", "--seed", "2", "--json"], { cwd: join(import.meta.dirname, ".."), env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
    expect(JSON.parse(r.stdout)).toMatchObject({ options: { n: 1, seed: 2 }, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  const DB = process.env.HAGGLE_TEST_DATABASE_URL;
  it.skipIf(!DB)("--repo pg runs the same deals on a throwaway Postgres with the same deterministic outcome shape", async () => {
    const mem = await runPilotBenchmark({ n: 2, seed: 11 });
    const pg = await runPilotBenchmark({ n: 2, seed: 11, repo: "pg", databaseUrl: DB! });
    expect(pg.summary.metrics).toMatchObject({ real_jobs: 0, simulated_jobs: 2 });
    expect(pg.deals.map((d) => [d.outcome, d.chosen, d.quotes, d.human_steps.length])).toEqual(mem.deals.map((d) => [d.outcome, d.chosen, d.quotes, d.human_steps.length]));
  });
});
