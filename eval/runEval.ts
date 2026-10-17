// AX eval (DESIGN.md §20.3): the same task, run headless through Claude Code
// with two tool setups, recording turns, tokens, wall time, cost, and whether
// the reported best quote is correct.
//
//   baseline:  Primitive's own MCP server only (email verbs, no catering logic)
//   treatment: Quote Broker only
//
// Run the simulators first, deterministically, so the right answer is known:
//   SIM_DETERMINISTIC=true SIM_DELAY_SCALE=0.3 npm run sim
// Then:  npm run eval -- --runs 5
//
// Needs in .env: QB_MCP_URL (e.g. https://wild-cloud-utpra.run.mcp-use.com/mcp),
// MCP_AUTH_TOKEN (if the server uses one), PRIMITIVE_API_KEY,
// PRIMITIVE_FROM_ADDRESS. Optional: PRIMITIVE_MCP_URL, EVAL_EXPECTED_BEST.
//
// TODO(verify): the Primitive MCP URL and auth header, and the exact fields of
// `claude -p --output-format json` (num_turns, usage, total_cost_usd, ...).
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PERSONAS } from "../sim/personas.ts";
import { join } from "node:path";

type Arm = "baseline" | "treatment";

interface RunResult {
  arm: Arm;
  run: number;
  ok: boolean;
  turns: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_s: number;
  cost_usd: number | null;
  correct: boolean;
  answer: string;
}

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const RUNS = Number(flag("runs", "5"));
const ARMS = flag("arms", "baseline,treatment").split(",") as Arm[];
const TIMEOUT_MS = Number(flag("timeout-minutes", "15")) * 60_000;
// With SIM_DETERMINISTIC=true the cheapest vegetarian-friendly vendor is Budget Bites.
const EXPECTED = process.env.EVAL_EXPECTED_BEST ?? "Budget Bites";

function env(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

function buildTask(): string {
  const personas = PERSONAS;
  const addresses = JSON.parse(readFileSync(new URL("../sim/.addresses.json", import.meta.url), "utf8")) as Record<string, string>;
  const vendors = personas
    .filter((p) => addresses[p.id])
    .map((p) => `  - ${p.name}: ${addresses[p.id]}`)
    .join("\n");
  const date = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
  return readFileSync(new URL("./task.md", import.meta.url), "utf8")
    .replace("{{DATE}}", date)
    .replace("{{VENDORS}}", vendors)
    .replace("{{FROM}}", env("PRIMITIVE_FROM_ADDRESS"));
}

/** MCP config for one arm, written to a temp dir so tokens never land in the repo. */
function writeMcpConfig(dir: string, arm: Arm): { path: string; allowedTools: string } {
  const config =
    arm === "treatment"
      ? {
          mcpServers: {
            "quote-broker": {
              type: "http",
              url: env("QB_MCP_URL"),
              ...(process.env.MCP_AUTH_TOKEN ? { headers: { Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN}` } } : {}),
            },
          },
        }
      : {
          mcpServers: {
            primitive: {
              type: "http",
              url: process.env.PRIMITIVE_MCP_URL ?? "https://www.primitive.dev/mcp",
              headers: { Authorization: `Bearer ${env("PRIMITIVE_API_KEY")}` },
            },
          },
        };
  const path = join(dir, `mcp-${arm}.json`);
  writeFileSync(path, JSON.stringify(config));
  return { path, allowedTools: arm === "treatment" ? "mcp__quote-broker" : "mcp__primitive" };
}

function runClaude(task: string, mcpConfig: string, allowedTools: string): Promise<{ stdout: string; ms: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      "claude",
      ["-p", task, "--output-format", "json", "--mcp-config", mcpConfig, "--strict-mcp-config", "--allowedTools", allowedTools],
      { shell: process.platform === "win32", stdio: ["ignore", "pipe", "inherit"] },
    );
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, ms: Date.now() - started });
    });
  });
}

function score(arm: Arm, run: number, stdout: string, ms: number): RunResult {
  let out: Record<string, unknown> = {};
  try {
    out = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    /* timed out or crashed: scored as a failure below */
  }
  const usage = (out.usage ?? {}) as Record<string, number>;
  const answer = typeof out.result === "string" ? out.result : "";
  // Heuristic: correct if the final answer names the expected vendor. Spot-check
  // the saved answers before quoting the numbers.
  const correct = answer.toLowerCase().includes(EXPECTED.toLowerCase());
  return {
    arm,
    run,
    ok: out.is_error === false,
    turns: typeof out.num_turns === "number" ? out.num_turns : null,
    input_tokens:
      usage.input_tokens !== undefined
        ? usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        : null,
    output_tokens: usage.output_tokens ?? null,
    duration_s: Math.round(ms / 1000),
    cost_usd: typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
    correct,
    answer: answer.slice(0, 400),
  };
}

const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const fmt = (x: number | null, digits = 0) => (x === null ? "n/a" : x.toFixed(digits));

const task = buildTask();
const tmp = mkdtempSync(join(tmpdir(), "qb-eval-"));
const results: RunResult[] = [];
try {
  for (const arm of ARMS) {
    const { path, allowedTools } = writeMcpConfig(tmp, arm);
    for (let run = 1; run <= RUNS; run++) {
      console.log(`[${arm}] run ${run}/${RUNS}...`);
      const { stdout, ms } = await runClaude(task, path, allowedTools);
      const r = score(arm, run, stdout, ms);
      results.push(r);
      console.log(`[${arm}] run ${run}: turns=${fmt(r.turns)} tokens=${fmt(r.input_tokens)}+${fmt(r.output_tokens)} ${r.duration_s}s correct=${r.correct}`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(results, null, 2));

console.log("\n| Arm | Runs | Correct | Avg turns | Avg input tokens | Avg output tokens | Avg time (s) | Avg cost ($) |");
console.log("|---|---|---|---|---|---|---|---|");
for (const arm of ARMS) {
  const rs = results.filter((r) => r.arm === arm);
  console.log(
    `| ${arm} | ${rs.length} | ${rs.filter((r) => r.correct).length}/${rs.length} | ${fmt(mean(rs.map((r) => r.turns)), 1)} | ${fmt(mean(rs.map((r) => r.input_tokens)))} | ${fmt(mean(rs.map((r) => r.output_tokens)))} | ${fmt(mean(rs.map((r) => r.duration_s)))} | ${fmt(mean(rs.map((r) => r.cost_usd)), 3)} |`,
  );
}
console.log(`\nSaved ${file.pathname}`);
