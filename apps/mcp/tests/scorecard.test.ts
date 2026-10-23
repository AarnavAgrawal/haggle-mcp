// The scorecard (scripts/scorecard.ts) reduces the existing simulated evaluations to six numbers and
// diffs two runs. The full run is exercised by the eval and benchmark tests; this checks the report.
import { describe, expect, it } from "vitest";
import { scorecardMarkdown, type Scorecard } from "../scripts/scorecard.ts";

const card = (over: (c: Scorecard) => void = () => {}): Scorecard => {
  const c: Scorecard = {
    label: "SIMULATED (scripted vendors, labelled corpus, fake clock; not real-world evidence)",
    options: { n: 10, seed: 1 },
    completion: {
      pilot_manual: { completed: 6, of: 6, receipt_verified: 6, correct_winner: 6 },
      benchmark_correct_end: { ok: 10, of: 10, verdicts: { completed: 4, correct_escalation: 6 }, escalations_naming_best: { ok: 1, of: 4 } },
      corpus_keyword_reader: { completed: 0, of: 6 },
    },
    extraction: { reader: "deterministic", cases: 59, outcome_ok: 40, total_correct: 38, total_of: 55, fields_correct: 237, fields_of: 328 },
    money_errors: { shown: 5, approvable: 0, total_wrong_unflagged: 2 },
    latency: { sim_min_first_quote: 0.1, sim_min_quotes_final: 10.4, sim_min_paid_pilot_mean: 82.2, wall_ms_per_tool_call: 5 },
    effort: { human_steps_benchmark: 1.1, human_texts_pilot: 2.2, tool_calls_benchmark: 32.2, tool_calls_pilot: 66.5, output_tokens_benchmark: 5662 },
    safety: { orchestration: 0, benchmark: 0, unsafe_quotes_approvable: 0, vendor_links_followed: 0 },
  };
  over(c);
  return c;
};

describe("scorecard report", () => {
  it("labels itself simulated and says the Claude extractor isn't measured", () => {
    const md = scorecardMarkdown(card());
    expect(md).toMatch(/^# Haggle scorecard: SIMULATED/);
    expect(md).toMatch(/Claude extractor production uses is not measured here/);
    expect(md).toMatch(/\| safety\.orchestration \| 0 \|/);
  });

  it("diffs two runs and marks only what changed", () => {
    const after = card((c) => { c.completion.benchmark_correct_end.escalations_naming_best.ok = 4; });
    const md = scorecardMarkdown(after, card());
    expect(md).toMatch(/\| completion\.benchmark_correct_end\.escalations_naming_best\.ok \| 1 \| 4 ◀ \|/);
    expect(md).toMatch(/\| money_errors\.shown \| 5 \| 5 \|/);
    expect(md.match(/◀/g)).toHaveLength(1);
  });
});
