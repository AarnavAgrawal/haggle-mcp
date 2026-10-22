// Operator report, read-only: what waits on a person, per workspace. Pending approvals, unresolved
// operator reviews (dead letters, holds, requested closes), failed or bounced communications,
// quarantined replies, stalled jobs and the recovery planner's findings, booking / payment handoffs
// awaiting action. Run it at the start of each pilot day and after any incident.
//
//   node --env-file=.env scripts/ops-report.ts [--json] [--workspace ws_...] [--days 7]
//
// It only reads (the report is built from the repository's read methods; see packages/engine
// src/ops/report.ts) and never calls Inkbox, Stripe or Anthropic. What to do about each line:
// docs/operator-recovery.md. Needs SUPABASE_DB_URL (the engine database).
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { buildOpsReport, formatOpsReport, PostgresRepository } from "@haggle/engine";

export type ReportCommand = { json: boolean; workspaceId?: string; days: number };

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Validate the command line (pure). */
export function planReport(argv: string[]): ReportCommand {
  const known = new Set(["--json", "--workspace", "--days"]);
  for (const [i, a] of argv.entries()) if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown option ${a} (use --json, --workspace ws_..., --days N)`);
  else if (!a.startsWith("--") && !["--workspace", "--days"].includes(argv[i - 1] ?? "")) throw new Error(`unexpected argument ${a}`);
  const ws = arg(argv, "workspace");
  if (ws !== undefined && !/^ws_[a-z0-9_]{3,40}$/.test(ws)) throw new Error("--workspace must be a workspace id like ws_acme");
  const days = Number(arg(argv, "days") ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("--days must be 1-60");
  return { json: argv.includes("--json"), days, ...(ws ? { workspaceId: ws } : {}) };
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planReport(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  try {
    const report = await buildOpsReport(repo, { closedWindowDays: cmd.days, ...(cmd.workspaceId ? { workspaceId: cmd.workspaceId } : {}) });
    console.log(cmd.json ? JSON.stringify(report, null, 2) : formatOpsReport(report));
  } finally {
    await repo.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops-report.ts")) {
  main().catch((e) => {
    console.error(`ops-report failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
