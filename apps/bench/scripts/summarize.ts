/**
 * Summarize Manufact suite runs (apps/bench/results/runs.csv) into the proof-slide table:
 * per arm and client — runs, pass rate, median judge score, tokens, cost, duration, tool calls, errors.
 * Empty cells are unknown and are left out of medians (never treated as zero).
 *
 *   npm run summarize -w @haggle/bench
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Run {
  arm: string;
  client: string;
  model: string;
  passed: boolean | undefined;
  score: number | undefined;
  tokens: number | undefined;
  cost_usd: number | undefined;
  duration_s: number | undefined;
  tool_calls: number | undefined;
  tool_errors: number | undefined;
}

const num = (s: string | undefined) => (s === undefined || s.trim() === "" ? undefined : Number(s));

export function parseRuns(csv: string): Run[] {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  if (!header) return [];
  const cols = header.split(",").map((c) => c.trim());
  return rows
    .filter((r) => r.trim() && !r.startsWith("#"))
    .map((r) => {
      const cells = r.split(",");
      const get = (name: string) => cells[cols.indexOf(name)]?.trim();
      const tin = num(get("tokens_in"));
      const tout = num(get("tokens_out"));
      const passed = get("passed");
      return {
        arm: get("arm") ?? "",
        client: get("client") ?? "",
        model: get("model") ?? "",
        passed: passed === "" || passed === undefined ? undefined : /^(1|true|yes|pass)$/i.test(passed),
        score: num(get("score")),
        tokens: tin === undefined && tout === undefined ? undefined : (tin ?? 0) + (tout ?? 0),
        cost_usd: num(get("cost_usd")),
        duration_s: num(get("duration_s")),
        tool_calls: num(get("tool_calls")),
        tool_errors: num(get("tool_errors")),
      };
    });
}

function median(xs: (number | undefined)[]): number | undefined {
  const v = xs.filter((x): x is number => x !== undefined && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return undefined;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1]! + v[m]!) / 2;
}

const fmt = (n: number | undefined, f: (n: number) => string) => (n === undefined ? "—" : f(n));

export function summarize(runs: Run[]): string {
  const groups = new Map<string, Run[]>();
  for (const r of runs) {
    const key = `${r.arm}\u0000${r.client}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const lines = [
    "| Arm | Client | Runs | Pass rate | Median score | Median tokens | Median cost | Median time | Median tool calls | Tool errors |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [key, rs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [arm, client] = key.split("\u0000");
    const judged = rs.filter((r) => r.passed !== undefined);
    const passRate = judged.length ? `${judged.filter((r) => r.passed).length}/${judged.length}` : "—";
    const errors = rs.every((r) => r.tool_errors === undefined) ? "—" : String(rs.reduce((s, r) => s + (r.tool_errors ?? 0), 0));
    lines.push(
      `| ${arm} | ${client} | ${rs.length} | ${passRate} | ${fmt(median(rs.map((r) => r.score)), (n) => `${Math.round(n)}%`)} | ` +
        `${fmt(median(rs.map((r) => r.tokens)), (n) => Math.round(n).toLocaleString("en-US"))} | ` +
        `${fmt(median(rs.map((r) => r.cost_usd)), (n) => `$${n.toFixed(2)}`)} | ` +
        `${fmt(median(rs.map((r) => r.duration_s)), (n) => `${Math.round(n)} s`)} | ` +
        `${fmt(median(rs.map((r) => r.tool_calls)), (n) => String(Math.round(n)))} | ${errors} |`,
    );
  }
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2] ?? fileURLToPath(new URL("../results/runs.csv", import.meta.url));
  const runs = parseRuns(readFileSync(path, "utf8"));
  console.log(runs.length ? summarize(runs) : `No runs recorded yet in ${path}. Add one row per Manufact run.`);
}
