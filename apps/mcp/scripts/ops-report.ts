// Operator report, read-only: what waits on a person, per workspace. Pending approvals (and expired
// ones still waiting), unresolved operator reviews (dead letters, holds, requested closes), failed or
// bounced communications, quarantined emails awaiting a decision, stalled jobs and the recovery
// planner's findings, unresolved bookings (awaiting the business, a texted "confirmed" waiting for the
// approver's BOOKED, not-in-writing awaiting attestation), payment handoffs (instructions requested or
// received, the customer reported paying with no receipt), pending CALL / CANCEL authorizations, and
// texts held because their number is on deals in several workspaces. Run it at the start of each pilot
// day and after any incident.
//
//   node --env-file=.env scripts/ops-report.ts [--brief | --json] [--workspace ws_...] [--days 7] [--fail-on-attention]
//
//   (default)            the full report, per workspace, ending with the next commands
//   --brief              one screen: status + counts per category, then one line per item with the
//                        exact next command (job-ops / quarantine / workspace-admin), oldest first
//   --json               everything, machine-readable (stable field names; `attention` holds the items)
//   --fail-on-attention  exit 2 when anything needs a person (ALL CLEAR exits 0), for cron or CI
//
// Exit codes: 0 report printed (and ALL CLEAR with --fail-on-attention); 2 attention with
// --fail-on-attention; 1 bad arguments, no database, or any other failure.
//
// It only reads (the report is built from the repository's read methods; see packages/engine
// src/ops/report.ts) and never calls Inkbox, Stripe or Anthropic. Contacts are masked; message
// bodies and approval / BOOKED / CALL / CANCEL codes are never shown. What to do about each line:
// docs/operator-recovery.md. Needs SUPABASE_DB_URL (the engine database).
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { buildOpsReport, formatOpsBrief, formatOpsReport, PostgresRepository, type OpsReport } from "@haggle/engine";

export type ReportCommand = { json: boolean; brief: boolean; failOnAttention: boolean; workspaceId?: string; days: number };

/** Exit code when the report printed but something needs a person (with --fail-on-attention). */
export const EXIT_ATTENTION = 2;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Validate the command line (pure). */
export function planReport(argv: string[]): ReportCommand {
  const known = new Set(["--json", "--brief", "--fail-on-attention", "--workspace", "--days"]);
  for (const [i, a] of argv.entries()) if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown option ${a} (use --brief or --json, --workspace ws_..., --days N, --fail-on-attention)`);
  else if (!a.startsWith("--") && !["--workspace", "--days"].includes(argv[i - 1] ?? "")) throw new Error(`unexpected argument ${a}`);
  const ws = arg(argv, "workspace");
  if (ws !== undefined && !/^ws_[a-z0-9_]{3,40}$/.test(ws)) throw new Error("--workspace must be a workspace id like ws_acme");
  const days = Number(arg(argv, "days") ?? 7);
  if (!Number.isInteger(days) || days < 1 || days > 60) throw new Error("--days must be 1-60");
  const json = argv.includes("--json");
  const brief = argv.includes("--brief");
  if (json && brief) throw new Error("--brief and --json are exclusive (--json already holds the brief's items under attention)");
  return { json, brief, failOnAttention: argv.includes("--fail-on-attention"), days, ...(ws ? { workspaceId: ws } : {}) };
}

/** What to print and the exit code (pure). */
export function renderReport(report: OpsReport, cmd: ReportCommand): { output: string; exitCode: number } {
  const output = cmd.json ? JSON.stringify(report, null, 2) : cmd.brief ? formatOpsBrief(report) : formatOpsReport(report);
  return { output, exitCode: cmd.failOnAttention && report.attention.total > 0 ? EXIT_ATTENTION : 0 };
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const cmd = planReport(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  try {
    const report = await buildOpsReport(repo, { closedWindowDays: cmd.days, ...(cmd.workspaceId ? { workspaceId: cmd.workspaceId } : {}) });
    const { output, exitCode } = renderReport(report, cmd);
    console.log(output);
    return exitCode;
  } finally {
    await repo.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/ops-report.ts")) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    console.error(`ops-report failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
