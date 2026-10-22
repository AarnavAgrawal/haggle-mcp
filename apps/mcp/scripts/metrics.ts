// Usage metrics, read-only: real usage and simulated runs side by side, computed only from database
// rows (packages/engine/src/ops/metrics.ts; definitions and the simulated-vs-real rule in
// docs/pilot-metrics.md). Sourcing completion, vendor response by channel, manual interventions,
// stage timings, the funnel, and Anthropic usage with an APPROXIMATE cost (ops/costs.ts).
//
//   node --env-file=.env scripts/metrics.ts [--json] [--since 2026-11-01] [--until 2026-12-01] [--workspace ws_...] [--min-quotes 3]
//
// Runs in one READ ONLY transaction (the database refuses any write), never calls a provider. Needs
// SUPABASE_DB_URL (migrations through 116; 122 adds per-job AI usage). HAGGLE_AI_PRICES overrides the
// price table (JSON, USD per million tokens).
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { analyticsSql, buildMetricsReport, loadMetricsDataset, metricsText, pricesWithOverride } from "@haggle/engine";

export type MetricsCommand = { json: boolean; since?: Date; until?: Date; workspace?: string; minQuotes: number };

const arg = (argv: string[], name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const day = (s: string | undefined, name: string) => {
  if (s === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`--${name} must be YYYY-MM-DD`);
  return new Date(`${s}T00:00:00Z`);
};

/** Validate the command line (pure). */
export function planMetrics(argv: string[]): MetricsCommand {
  const valued = ["--since", "--until", "--workspace", "--min-quotes"];
  for (const [i, a] of argv.entries()) {
    if (a.startsWith("--") && a !== "--json" && !valued.includes(a)) throw new Error(`unknown option ${a} (use --json, --since YYYY-MM-DD, --until YYYY-MM-DD, --workspace ws_..., --min-quotes N)`);
    if (!a.startsWith("--") && !valued.includes(argv[i - 1] ?? "")) throw new Error(`unexpected argument ${a}`);
  }
  const since = day(arg(argv, "since"), "since");
  const until = day(arg(argv, "until"), "until");
  if (since && until && until <= since) throw new Error("--until must be after --since");
  const ws = arg(argv, "workspace");
  if (ws !== undefined && !/^ws_[a-z0-9_]{3,40}$/.test(ws)) throw new Error("--workspace must be a workspace id like ws_acme");
  const minQuotes = Number(arg(argv, "min-quotes") ?? 3);
  if (!Number.isInteger(minQuotes) || minQuotes < 1 || minQuotes > 10) throw new Error("--min-quotes must be 1-10");
  return { json: argv.includes("--json"), minQuotes, ...(since ? { since } : {}), ...(until ? { until } : {}), ...(ws ? { workspace: ws } : {}) };
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planMetrics(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const prices = pricesWithOverride(process.env.HAGGLE_AI_PRICES);
  const sql = analyticsSql(url);
  try {
    // One consistent snapshot; the database itself refuses any write in a read-only transaction.
    const data = await sql.begin("isolation level repeatable read read only", (tx) => loadMetricsDataset(tx as never, cmd));
    const report = buildMetricsReport(data, { minValidQuotes: cmd.minQuotes, prices, window: { since: cmd.since?.toISOString().slice(0, 10) ?? null, until: cmd.until?.toISOString().slice(0, 10) ?? null, workspace: cmd.workspace ?? null } });
    console.log(cmd.json ? JSON.stringify(report, null, 2) : metricsText(report));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/metrics.ts")) {
  main().catch((e) => {
    console.error(`metrics failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
