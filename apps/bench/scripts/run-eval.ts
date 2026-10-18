/**
 * AX eval runner (ported from haggle-testing's eval/runEval.ts): the same task, run headless in
 * Claude Code against two arms, appended to results/runs.csv for `npm run summarize`.
 *
 *   haggle    Haggle's MCP server only  (HAGGLE_EVAL_URL, default http://localhost:3000/mcp,
 *                                        optional Authorization: Bearer $HAGGLE_EVAL_TOKEN)
 *   baseline  the raw-Inkbox server in this app (BASELINE_EVAL_URL, default http://localhost:3100/mcp;
 *                                        set it to "" to skip; skipped with a warning if unreachable)
 *
 *   npm run eval -w @haggle/bench -- [--runs 3] [--task catering] [--arm haggle|baseline] [--model <id>] [--dry-run]
 *
 * --dry-run prints the claude commands, MCP configs and the CSV rows it would append, and runs nothing
 * (no spawn, no network, no CSV write). Each real run costs Claude credits.
 *
 * TODO(verify): the `claude -p --output-format json` field names (num_turns, usage.*, total_cost_usd,
 * duration_ms, result, is_error, modelUsage) and the shape `--verbose` adds (a JSON array of transcript
 * messages ending in the result message). The parser below accepts either an object or an array.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const CSV_HEADER = "arm,client,model,run,passed,score,tokens_in,tokens_out,cost_usd,duration_s,tool_calls,tool_errors,notes";
const CSV_COLUMNS = CSV_HEADER.split(",");

export type Arm = "haggle" | "baseline";
export const ARMS: readonly Arm[] = ["haggle", "baseline"];

export interface Task {
  name: string;
  /** Business name the final answer must name; empty or a <placeholder> means "not judged". */
  expectedBest: string;
  meta: Record<string, string>;
  prompt: string;
}

// ───────────────────────────── tasks ─────────────────────────────

/** Split `---\nkey: value\n---\nbody`. Keys are `key: value` lines; `#` lines and blanks are ignored. */
export function parseFrontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const m = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    meta[key] = value;
  }
  return { meta, body: m[2]! };
}

/** Front-matter lists are `;`-separated (contacts contain commas less often than semicolons). */
export const splitList = (s: string | undefined) => (s ?? "").split(";").map((x) => x.trim()).filter(Boolean);

/** Build a task: `{{contacts}}` in the body becomes a bulleted list of the front matter's contacts. */
export function parseTask(name: string, raw: string): Task {
  const { meta, body } = parseFrontMatter(raw);
  const contacts = splitList(meta.contacts).map((c) => `- ${c}`).join("\n");
  return { name, expectedBest: meta.expected_best ?? "", meta, prompt: body.replaceAll("{{contacts}}", contacts).trim() };
}

/** An expected_best the operator still has to fill in (`<...>`, TODO, TBD) is not judged. */
export const isPlaceholder = (s: string) => !s.trim() || /^<.*>$/.test(s.trim()) || /^(todo|tbd|fill[- ]?me)\b/i.test(s.trim());

export function loadTasks(dir: string, only?: string): Task[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseTask(f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")))
    .filter((t) => !only || t.name === only);
}

// ───────────────────────────── arms & claude args ─────────────────────────────

export interface McpConfig {
  mcpServers: Record<string, { type: "http"; url: string; headers?: Record<string, string> }>;
}

export interface ArmConfig {
  arm: Arm;
  /** MCP server name; Claude Code exposes its tools as mcp__<server>__<tool>. */
  server: string;
  url: string;
  allowedTools: string;
  mcp: McpConfig;
}

export function armConfig(arm: Arm, env: Record<string, string | undefined>): ArmConfig | { arm: Arm; skip: string } {
  if (arm === "haggle") {
    const url = env.HAGGLE_EVAL_URL || "http://localhost:3000/mcp";
    const token = env.HAGGLE_EVAL_TOKEN;
    return {
      arm, server: "haggle", url, allowedTools: "mcp__haggle",
      mcp: { mcpServers: { haggle: { type: "http", url, ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) } } },
    };
  }
  const url = env.BASELINE_EVAL_URL === undefined ? "http://localhost:3100/mcp" : env.BASELINE_EVAL_URL.trim();
  if (!url) return { arm, skip: "BASELINE_EVAL_URL is set to empty" };
  return { arm, server: "baseline", url, allowedTools: "mcp__baseline", mcp: { mcpServers: { baseline: { type: "http", url } } } };
}

export interface ClaudeArgsInput {
  /** Omit to send the prompt on stdin (needed on Windows, where claude is a .cmd shim run through a shell). */
  prompt?: string;
  mcpConfigPath: string;
  allowedTools: string;
  model?: string;
}

export function buildClaudeArgs({ prompt, mcpConfigPath, allowedTools, model }: ClaudeArgsInput): string[] {
  return [
    "-p", ...(prompt !== undefined ? [prompt] : []),
    "--output-format", "json",
    // TODO(verify): with --verbose, json output is the full transcript array; we use it to count tool calls.
    "--verbose",
    "--strict-mcp-config",
    "--mcp-config", mcpConfigPath,
    "--allowedTools", allowedTools,
    ...(model ? ["--model", model] : []),
  ];
}

/** Hide bearer tokens when printing a config. */
export function redactConfig(cfg: McpConfig): McpConfig {
  const servers = Object.fromEntries(
    Object.entries(cfg.mcpServers).map(([k, s]) => [
      k,
      s.headers ? { ...s, headers: Object.fromEntries(Object.entries(s.headers).map(([h, v]) => [h, /^authorization$/i.test(h) ? v.replace(/^(Bearer\s+).+$/i, "$1***") : v])) } : s,
    ]),
  );
  return { mcpServers: servers };
}

// ───────────────────────────── result → CSV row ─────────────────────────────

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const numOr = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

export interface ParsedClaude {
  result: string;
  isError: boolean;
  model?: string;
  turns?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
  toolCalls?: number;
  toolErrors?: number;
}

/** Read claude's json output (an object, or with --verbose an array of messages). Unknown fields stay undefined. */
export function parseClaudeOutput(output: unknown): ParsedClaude {
  const messages = Array.isArray(output) ? output.filter(isObj) : [];
  const res: Json = Array.isArray(output) ? ([...messages].reverse().find((m) => m.type === "result") ?? {}) : isObj(output) ? output : {};

  const usage = isObj(res.usage) ? res.usage : {}; // TODO(verify): usage.{input_tokens,cache_read_input_tokens,cache_creation_input_tokens,output_tokens}
  const input = numOr(usage.input_tokens);
  const tokensIn = input === undefined ? undefined : input + (numOr(usage.cache_read_input_tokens) ?? 0) + (numOr(usage.cache_creation_input_tokens) ?? 0);

  // TODO(verify): model name — modelUsage is keyed by model id; the system/init message carries `model`.
  const modelUsage = isObj(res.modelUsage) ? Object.keys(res.modelUsage) : [];
  const init = messages.find((m) => m.type === "system" && typeof m.model === "string");
  const model = typeof res.model === "string" ? res.model : (modelUsage[0] ?? (init?.model as string | undefined));

  // Tool calls: tool_use blocks in assistant messages; errors: tool_result blocks with is_error. Only
  // available from the --verbose transcript. TODO(verify): message.content block shapes.
  let toolCalls: number | undefined;
  let toolErrors: number | undefined;
  if (messages.length) {
    toolCalls = 0;
    toolErrors = 0;
    for (const m of messages) {
      const content = isObj(m.message) && Array.isArray(m.message.content) ? m.message.content.filter(isObj) : [];
      for (const b of content) {
        if (m.type === "assistant" && b.type === "tool_use") toolCalls++;
        if (m.type === "user" && b.type === "tool_result" && b.is_error === true) toolErrors++;
      }
    }
  }

  return {
    result: typeof res.result === "string" ? res.result : "", // TODO(verify): final text in `result`
    isError: res.is_error === true || (typeof res.subtype === "string" && res.subtype !== "success"), // TODO(verify): is_error / subtype
    ...(model ? { model } : {}),
    ...(numOr(res.num_turns) !== undefined ? { turns: numOr(res.num_turns)! } : {}), // TODO(verify): num_turns
    ...(tokensIn !== undefined ? { tokensIn } : {}),
    ...(numOr(usage.output_tokens) !== undefined ? { tokensOut: numOr(usage.output_tokens)! } : {}),
    ...(numOr(res.total_cost_usd) !== undefined ? { costUsd: numOr(res.total_cost_usd)! } : {}), // TODO(verify): total_cost_usd
    ...(numOr(res.duration_ms) !== undefined ? { durationMs: numOr(res.duration_ms)! } : {}), // TODO(verify): duration_ms
    ...(toolCalls !== undefined ? { toolCalls, toolErrors: toolErrors! } : {}),
  };
}

/** Did the final answer name the expected winner? undefined when the task has no expected_best yet. */
export function judgePassed(resultText: string, expectedBest: string): boolean | undefined {
  if (isPlaceholder(expectedBest)) return undefined;
  return resultText.toLowerCase().includes(expectedBest.trim().toLowerCase());
}

export interface RowInput {
  arm: Arm;
  task: Task;
  run: number;
  /** Raw parsed JSON from claude, or null when the output wasn't JSON. */
  output: unknown;
  /** Wall-clock fallback when the JSON has no duration_ms. */
  wallMs?: number;
  /** Fallback model when the JSON doesn't name one (--model / HAGGLE_EVAL_MODEL). */
  model?: string;
  extraNotes?: string[];
  /** Preview row for --dry-run: nothing ran, so nothing is judged. */
  dryRun?: boolean;
}

export type CsvRow = Record<(typeof CSV_COLUMNS)[number], string>;

const cell = (n: number | undefined, digits?: number) => (n === undefined ? "" : digits === undefined ? String(n) : String(Number(n.toFixed(digits))));

/** Turn one claude result into a runs.csv row. Unknown values are empty (never zero). */
export function resultToRow({ arm, task, run, output, wallMs, model, extraNotes = [], dryRun = false }: RowInput): CsvRow {
  const p = parseClaudeOutput(output);
  const passed = dryRun ? undefined : judgePassed(p.result, task.expectedBest);
  const ms = p.durationMs ?? wallMs;
  const notes = [`task=${task.name}`];
  if (dryRun) notes.push("dry-run");
  else {
    if (p.turns !== undefined) notes.push(`turns=${p.turns}`);
    if (output === null || output === undefined) notes.push("no JSON output");
    else if (p.isError) notes.push("claude reported an error");
    if (passed === undefined) notes.push("expected_best not set: not judged");
    else if (!passed) notes.push(`answer did not name ${task.expectedBest}`);
  }
  notes.push(...extraNotes);
  return {
    arm,
    client: "claude-code",
    model: p.model ?? model ?? "",
    run: String(run),
    passed: passed === undefined ? "" : String(passed && !p.isError),
    score: "",
    tokens_in: cell(p.tokensIn),
    tokens_out: cell(p.tokensOut),
    cost_usd: cell(p.costUsd, 4),
    duration_s: cell(ms === undefined ? undefined : ms / 1000, 1),
    tool_calls: cell(p.toolCalls),
    tool_errors: cell(p.toolErrors),
    notes: notes.join("; "),
  };
}

/** RFC 4180: quote a cell holding a comma, quote, CR or LF; double inner quotes. */
export function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export const rowToCsv = (row: CsvRow) => CSV_COLUMNS.map((c) => csvEscape(row[c] ?? "")).join(",");

// ───────────────────────────── runner (side effects) ─────────────────────────────

/** Quote an argument for cmd.exe when spawning through a shell on Windows. */
const winQuote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

function runClaude(prompt: string, args: string[]): Promise<{ output: unknown; ms: number; stderr: string }> {
  const started = Date.now();
  const win = process.platform === "win32";
  return new Promise((resolve) => {
    const child = spawn("claude", win ? args.map(winQuote) : args, { shell: win, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => {
      err += d;
      process.stderr.write(d);
    });
    child.on("error", (e) => resolve({ output: null, ms: Date.now() - started, stderr: `${err}${e.message}` }));
    child.on("close", () => {
      let output: unknown = null;
      try {
        output = JSON.parse(out);
      } catch {
        output = null;
      }
      resolve({ output, ms: Date.now() - started, stderr: err });
    });
    // On Windows the prompt goes on stdin (multi-line args don't survive cmd.exe); elsewhere stdin is just closed.
    if (win) child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Any HTTP answer counts as reachable (an MCP endpoint may 4xx a bare GET). */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(3_000) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: "3" },
      task: { type: "string" },
      arm: { type: "string" },
      model: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer (got ${values.runs})`);
  if (values.arm && !ARMS.includes(values.arm as Arm)) throw new Error(`--arm must be one of ${ARMS.join(", ")}`);
  const dry = values["dry-run"];
  const model = values.model ?? process.env.HAGGLE_EVAL_MODEL;

  const benchDir = fileURLToPath(new URL("..", import.meta.url));
  const csvPath = join(benchDir, "results", "runs.csv");
  const tasks = loadTasks(join(benchDir, "tasks"), values.task);
  if (!tasks.length) throw new Error(`No tasks${values.task ? ` named ${values.task}` : ""} in ${join(benchDir, "tasks")}`);

  const tmp = mkdtempSync(join(tmpdir(), "haggle-eval-"));
  const rows: CsvRow[] = [];
  try {
    for (const arm of ARMS.filter((a) => !values.arm || a === values.arm)) {
      const cfg = armConfig(arm, process.env);
      if ("skip" in cfg) {
        console.warn(`[eval] skipping ${arm}: ${cfg.skip}`);
        continue;
      }
      if (!dry && !(await reachable(cfg.url))) {
        console.warn(`[eval] skipping ${arm}: ${cfg.url} is unreachable (start it first, or set ${arm === "haggle" ? "HAGGLE_EVAL_URL" : "BASELINE_EVAL_URL"})`);
        continue;
      }
      const mcpPath = join(tmp, `mcp-${arm}.json`);
      if (!dry) writeFileSync(mcpPath, JSON.stringify(cfg.mcp, null, 2));
      else console.log(`\n[eval] ${arm} MCP config (${mcpPath}):\n${JSON.stringify(redactConfig(cfg.mcp), null, 2)}`);

      for (const task of tasks) {
        if (isPlaceholder(task.expectedBest)) console.warn(`[eval] ${task.name}: expected_best is a placeholder, so runs are recorded but not judged`);
        for (let i = 1; i <= runs; i++) {
          const viaStdin = process.platform === "win32";
          const args = buildClaudeArgs({ ...(viaStdin ? {} : { prompt: task.prompt }), mcpConfigPath: mcpPath, allowedTools: cfg.allowedTools, ...(model ? { model } : {}) });
          if (dry) {
            const shown = buildClaudeArgs({ prompt: "<prompt>", mcpConfigPath: mcpPath, allowedTools: cfg.allowedTools, ...(model ? { model } : {}) });
            console.log(`[eval] dry-run ${arm} / ${task.name} / run ${i}: claude ${shown.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
            if (i === 1) console.log(`  prompt (${viaStdin ? "stdin" : "argv"}):\n${task.prompt.replace(/^/gm, "    ")}`);
            const row = resultToRow({ arm, task, run: i, output: null, ...(model ? { model } : {}), dryRun: true });
            console.log(`  row: ${rowToCsv(row)}`);
            continue;
          }
          console.log(`[eval] ${arm} / ${task.name} / run ${i}`);
          const { output, ms, stderr } = await runClaude(task.prompt, args);
          const extra = output === null && stderr.trim() ? [`stderr: ${stderr.trim().split(/\r?\n/).pop()!.slice(0, 160)}`] : [];
          const row = resultToRow({ arm, task, run: i, output, wallMs: ms, ...(model ? { model } : {}), extraNotes: extra });
          rows.push(row);
          if (!existsSync(csvPath) || !readFileSync(csvPath, "utf8").trim()) writeFileSync(csvPath, `${CSV_HEADER}\n`);
          const existing = readFileSync(csvPath, "utf8");
          appendFileSync(csvPath, `${existing.endsWith("\n") ? "" : "\n"}${rowToCsv(row)}\n`);
          console.log(`  passed=${row.passed || "?"} tokens=${row.tokens_in || "?"}/${row.tokens_out || "?"} cost=${row.cost_usd || "?"} time=${row.duration_s || "?"}s tools=${row.tool_calls || "?"}`);
        }
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  if (dry) console.log("\n[eval] dry-run: nothing was spawned and runs.csv was not changed.");
  else console.log(`\n[eval] appended ${rows.length} row(s) to ${csvPath}. Next: npm run summarize -w @haggle/bench`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[eval] ${(e as Error).message}`);
    process.exit(1);
  });
}
