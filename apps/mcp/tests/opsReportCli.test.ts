// scripts/ops-report.ts command line: flags, output mode and the exit code a cron job or CI step sees
// (--fail-on-attention: 0 ALL CLEAR, 2 when something needs a person). Built on the in-memory store
// with a fixed fake clock; the real script reads the engine database and never calls a provider.
import { describe, expect, it } from "vitest";
import { buildOpsReport, InMemoryRepository } from "@haggle/engine";
import { EXIT_ATTENTION, planReport, renderReport } from "../scripts/ops-report.ts";
import { BUDGET, kit, mail, newClock, REQUEST } from "../../../packages/engine/tests/helpers/reliabilityKit.ts";

const T0 = Date.parse("2026-10-22T16:00:00Z");

describe("ops-report command line", () => {
  it("parses flags; rejects unknown, conflicting and malformed ones", () => {
    expect(planReport([])).toEqual({ json: false, brief: false, failOnAttention: false, days: 7 });
    expect(planReport(["--brief", "--fail-on-attention", "--workspace", "ws_acme", "--days", "3"])).toEqual({ json: false, brief: true, failOnAttention: true, days: 3, workspaceId: "ws_acme" });
    expect(planReport(["--json", "--fail-on-attention"])).toMatchObject({ json: true, failOnAttention: true });
    expect(() => planReport(["--brief", "--json"])).toThrow(/exclusive/);
    expect(() => planReport(["--fail-on-attentoin"])).toThrow(/unknown option/);
    expect(() => planReport(["--workspace", "acme"])).toThrow(/workspace id/);
    expect(() => planReport(["--days", "0"])).toThrow(/1-60/);
    expect(() => planReport(["extra"])).toThrow(/unexpected argument/);
  });

  it("ALL CLEAR exits 0 even with --fail-on-attention; attention exits 2 only with it", async () => {
    const clock = newClock(T0);
    const empty = await buildOpsReport(new InMemoryRepository({ now: clock.now }), { now: clock.now() });
    for (const flags of [["--fail-on-attention"], ["--brief", "--fail-on-attention"], ["--json", "--fail-on-attention"]]) {
      const r = renderReport(empty, planReport(flags));
      expect(r.exitCode).toBe(0);
      expect(r.output).toMatch(/ALL CLEAR/);
    }

    // A real deal through the engine: a quote in, an approval request the human hasn't answered.
    const repo = new InMemoryRepository({ now: clock.now });
    const k = kit({}, { repo, clock });
    const d = await k.engine.deal({ request: REQUEST, budget_usd: BUDGET, businesses: [{ name: "Sunset Kitchen", email: "sunset@inkboxmail.test" }] });
    await mail(k, (await repo.getBusinesses(d.job_id))[0]!, "We can do it: $1,150 total, delivered. $345 deposit.");
    await k.engine.advanceJob(d.job_id);
    await k.engine.requestApproval(d.job_id, (await k.engine.getQuotes(d.job_id)).quotes[0]!.quote_id, "imessage");
    const report = await buildOpsReport(repo, { now: clock.now() });
    expect(report.attention.by_category.pending_approval).toBe(1);

    expect(renderReport(report, planReport([])).exitCode).toBe(0);
    expect(renderReport(report, planReport(["--brief"])).exitCode).toBe(0);
    const brief = renderReport(report, planReport(["--brief", "--fail-on-attention"]));
    expect(brief.exitCode).toBe(EXIT_ATTENTION);
    expect(brief.output.split("\n")[0]).toMatch(/ATTENTION: \d+ items?$/);
    expect(brief.output).toContain(`scripts/job-ops.ts inspect --job ${d.job_id}`);
    expect(brief.output).not.toContain("sunset@inkboxmail.test");
    const json = renderReport(report, planReport(["--json", "--fail-on-attention"]));
    expect(json.exitCode).toBe(EXIT_ATTENTION);
    expect(JSON.parse(json.output)).toMatchObject({ attention: { status: "ATTENTION" } });
    expect(renderReport(report, planReport(["--fail-on-attention"])).output).toMatch(/Next commands \(oldest first\):/);
  });
});
