# @haggle/bench

The benchmark: `index.ts` is the **haggle-baseline** MCP server (raw Inkbox email and phone tools, no
Haggle logic), `suites/` holds the Manufact suite spec, `results/runs.csv` collects runs and
`scripts/summarize.ts` turns them into the proof-slide table.

## Headless AX eval (Claude Code)

`scripts/run-eval.ts` runs each task in `tasks/` N times per arm with `claude -p ... --output-format json
--strict-mcp-config --mcp-config <tmp> --allowedTools <arm>` and appends one row per run to
`results/runs.csv` (`client` = `claude-code`, `score` empty: there is no judge here; `passed` = the final
answer names the task's `expected_best`).

| Arm | Server | Env | Allowed tools |
| --- | --- | --- | --- |
| `haggle` | Haggle MCP | `HAGGLE_EVAL_URL` (default `http://localhost:3000/mcp`), optional `HAGGLE_EVAL_TOKEN` (sent as `Authorization: Bearer`; needed when `HAGGLE_AUTH=required`) | `mcp__haggle` |
| `baseline` | this app | `BASELINE_EVAL_URL` (default `http://localhost:3100/mcp`; set it to empty to skip) | `mcp__baseline` |

An arm whose server doesn't answer is skipped with a warning. `HAGGLE_EVAL_MODEL` or `--model` picks the
model (it's also the CSV `model` when claude's JSON doesn't name one).

1. Start Haggle. Mock mode (simulated fleet, no real contacts): `npm run demo:server` at the repo root.
2. Start the baseline: `BASELINE_HANDLE=haggle-baseline npm run dev -w @haggle/bench` (port 3100). It
   talks to real Inkbox, so only point it at the real seller identities (see `suites/offsite-catering.md`),
   not the mock `.sim.haggle.dev` addresses; otherwise run `--arm haggle` only.
3. Preview, then run (each real run costs Claude credits):

   ```sh
   npm run eval -w @haggle/bench -- --dry-run --runs 1     # prints commands, MCP configs and rows; spawns nothing
   npm run eval -w @haggle/bench -- --runs 3               # flags: --task catering|plumbing, --arm haggle|baseline, --model <id>
   npm run summarize -w @haggle/bench
   ```

Tasks are Markdown with simple front matter: `expected_best` (business name the answer must contain) and
`contacts` (`;`-separated, substituted for `{{contacts}}`). `tasks/catering.md` is the offsite scenario
with the mock fleet (Bay Catering wins at $995 after negotiation); swap in the real addresses for live
runs. `tasks/plumbing.md` exercises custom `ask` fields and is live-only: fill in its contacts and
`expected_best` first (while `expected_best` is a `<placeholder>`, runs are recorded with `passed` empty).

The claude JSON field names (`num_turns`, `usage.*`, `total_cost_usd`, `duration_ms`, `modelUsage`, and the
`--verbose` transcript used to count tool calls) are marked `TODO(verify)` in the script; anything missing
is left empty in the CSV, never zero.
