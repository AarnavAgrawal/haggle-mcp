// Product scorecard: one SIMULATED run of the existing evaluations, reduced to the six numbers the team
// tracks per commit, with a before/after diff. Nothing new is measured here and nothing is contacted:
//   - the pilot benchmark (scripts/pilot-benchmark.ts: mock mode, the six DEMO vendors, seeded deals);
//   - the extraction eval (packages/engine/eval/extraction.ts: the labelled corpus, read by the
//     deterministic keyword reader; the label oracle checks the scoring);
//   - the orchestration eval (packages/engine/eval/orchestration.ts: corpus deals through the real
//     engine in live configuration, a scripted agent, attacks on every deal, and the pilot's manual
//     payment handoff end to end).
// The Claude extractor production uses is NOT run (it needs HAGGLE_EVAL_LIVE=1 and a dollar cap; see
// scripts/eval-report.ts), so extraction accuracy here is the offline fallback reader's, a floor.
//
//   npx tsx apps/mcp/scripts/scorecard.ts [--n 10] [--seed 1] [--json] [--out file.json] [--compare before.json]
import { readFileSync, writeFileSync } from "node:fs";
import { loadCorpus } from "../../../packages/engine/eval/corpus.ts";
import { runExtractionEval } from "../../../packages/engine/eval/extraction.ts";
import { runOrchestration, unsafeTotal, type DealRun } from "../../../packages/engine/eval/orchestration.ts";
import { runPilotBenchmark } from "./pilot-benchmark.ts";

export interface Scorecard {
  label: "SIMULATED (scripted vendors, labelled corpus, fake clock; not real-world evidence)";
  options: { n: number; seed: number };
  /** 1. End-to-end workflow completion. */
  completion: {
    /** The pilot path (manual payment handoff), perfect reader: the human reported paying a vendor that confirmed in writing. */
    pilot_manual: { completed: number; of: number; receipt_verified: number; correct_winner: number };
    /** Mock fleet benchmark: deals that ended where a careful buyer would (bought, or handed the human an explained choice). */
    benchmark_correct_end: { ok: number; of: number; verdicts: Record<string, number>; escalations_naming_best: { ok: number; of: number } };
    /** The same corpus deals with the keyword reader: a keyword reading is never approvable, so this is expected to be 0. */
    corpus_keyword_reader: { completed: number; of: number };
  };
  /** 2. Quote-extraction accuracy (deterministic keyword reader: the floor; Claude unmeasured). */
  extraction: { reader: string; cases: number; outcome_ok: number; total_correct: number; total_of: number; fields_correct: number; fields_of: number };
  /** 3. Financial-field errors: a wrong dollar amount shown to the human, and one a human could approve. */
  money_errors: { shown: number; approvable: number; total_wrong_unflagged: number };
  /** 4. Latency: simulated minutes (median) and machine wall-clock per tool call. */
  latency: { sim_min_first_quote: number | null; sim_min_quotes_final: number | null; sim_min_paid_pilot_mean: number | null; wall_ms_per_tool_call: number };
  /** 5. Human intervention and agent effort per deal. */
  effort: { human_steps_benchmark: number; human_texts_pilot: number; tool_calls_benchmark: number; tool_calls_pilot: number; output_tokens_benchmark: number };
  /** 6. Safety violations across every run (each must be 0). */
  safety: { orchestration: number; benchmark: number; unsafe_quotes_approvable: number; vendor_links_followed: number };
}

const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

export async function runScorecard(o: { n: number; seed: number }): Promise<Scorecard> {
  const bench = await runPilotBenchmark({ n: o.n, seed: o.seed });
  const corpus = loadCorpus();
  const det = await runExtractionEval(corpus, "deterministic", {});
  const runs: DealRun[] = await runOrchestration();
  const arm = (a: string) => runs.filter((r) => r.arm === a);
  const pilot = arm("pilot:manual");
  const fields = Object.values(det.fields.fields);
  const s = bench.summary;
  return {
    label: "SIMULATED (scripted vendors, labelled corpus, fake clock; not real-world evidence)",
    options: o,
    completion: {
      pilot_manual: { completed: pilot.filter((r) => r.completed).length, of: pilot.length, receipt_verified: pilot.filter((r) => r.money_verified).length, correct_winner: pilot.filter((r) => r.winner_ok === true).length },
      benchmark_correct_end: { ok: s.verdicts.completed + s.verdicts.correct_escalation, of: bench.deals.length, verdicts: s.verdicts, escalations_naming_best: s.escalations_naming_best },
      corpus_keyword_reader: { completed: arm("corpus:deterministic").filter((r) => r.completed).length, of: arm("corpus:deterministic").length },
    },
    extraction: {
      reader: det.extractor_label, cases: det.cases, outcome_ok: det.outcome_accuracy.ok,
      total_correct: det.total.correct, total_of: det.cases - det.total["n/a"],
      fields_correct: fields.reduce((a, f) => a + f.correct, 0), fields_of: fields.reduce((a, f) => a + f.of, 0),
    },
    money_errors: { shown: det.fields.money_errors_shown.count, approvable: det.fields.money_errors_approvable.count, total_wrong_unflagged: det.total.wrong_unflagged },
    latency: {
      sim_min_first_quote: s.sim_minutes.first_quote_median, sim_min_quotes_final: s.sim_minutes.ready_median,
      sim_min_paid_pilot_mean: avg(pilot.flatMap((r) => (r.paid_after_min === null ? [] : [r.paid_after_min]))), wall_ms_per_tool_call: s.wall_ms.mean_per_tool_call,
    },
    effort: {
      human_steps_benchmark: s.human_steps.mean, human_texts_pilot: avg(pilot.map((r) => (r.human_texts ?? []).length + r.questions_answered)) ?? 0,
      tool_calls_benchmark: s.tool_calls.mean, tool_calls_pilot: avg(pilot.map((r) => r.tool_calls_total)) ?? 0, output_tokens_benchmark: s.output_chars.est_tokens_mean,
    },
    safety: {
      orchestration: runs.reduce((a, r) => a + unsafeTotal(r.unsafe), 0), benchmark: s.safety_violations,
      unsafe_quotes_approvable: det.unsafe_approvable.length, vendor_links_followed: det.fetches + runs.reduce((a, r) => a + r.unsafe.followed_vendor_link, 0),
    },
  };
}

/** Flattens to "path: value" rows (numbers and short records only) for the diff. */
function rows(x: unknown, prefix = ""): [string, unknown][] {
  if (x === null || typeof x !== "object") return [[prefix, x]];
  return Object.entries(x as Record<string, unknown>).flatMap(([k, v]) => (k === "label" || k === "reader" ? [] : rows(v, prefix ? `${prefix}.${k}` : k)));
}

export function scorecardMarkdown(c: Scorecard, before?: Scorecard): string {
  const prev = new Map(before ? rows(before) : []);
  const fmt = (v: unknown) => (v === null || v === undefined ? "—" : String(v));
  return [
    `# Haggle scorecard: ${c.label}`,
    "",
    `Benchmark n=${c.options.n}, seed=${c.options.seed}; corpus and orchestration are fixed. Extraction is the offline keyword reader's (a floor): the Claude extractor production uses is not measured here.`,
    "",
    before ? "| Metric | Before | After |" : "| Metric | Value |",
    before ? "| --- | --- | --- |" : "| --- | --- |",
    ...rows(c).map(([k, v]) => (before ? `| ${k} | ${fmt(prev.get(k))} | ${fmt(v)}${prev.has(k) && prev.get(k) !== v ? " ◀" : ""} |` : `| ${k} | ${fmt(v)} |`)),
    "",
  ].join("\n");
}

const arg = (argv: string[], name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

async function main(argv = process.argv.slice(2)) {
  const n = Number(arg(argv, "n") ?? 10);
  const seed = Number(arg(argv, "seed") ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 200) throw new Error("--n must be 1-200");
  if (!Number.isInteger(seed) || seed < 0) throw new Error("--seed must be a non-negative integer");
  const c = await runScorecard({ n, seed });
  const out = arg(argv, "out");
  if (out) writeFileSync(out, JSON.stringify(c, null, 2));
  const cmp = arg(argv, "compare");
  const before = cmp ? (JSON.parse(readFileSync(cmp, "utf8")) as Scorecard) : undefined;
  console.log(argv.includes("--json") ? JSON.stringify(c, null, 2) : scorecardMarkdown(c, before));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/scorecard.ts")) {
  main().catch((e) => {
    console.error(`scorecard failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
