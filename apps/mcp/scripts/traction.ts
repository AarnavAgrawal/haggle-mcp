// Pilot traction and abandonment report, read from the engine database (migration 116's analytics
// views): verified outcomes only, never mock jobs, test workspaces/jobs, simulated businesses or
// simulated/test-mode payments. Also marks a workspace or job as test (append-only).
//
//   node --env-file=.env scripts/traction.ts report [--json] [--since 2026-11-01]
//   node --env-file=.env scripts/traction.ts mark-test --workspace ws_acme_demo --reason "internal demo" --by "<your name>"
//   node --env-file=.env scripts/traction.ts mark-test --job job_... --reason "smoke test" --by "<your name>"
//   node --env-file=.env scripts/traction.ts unmark-test --workspace ws_... --reason "real pilot after all" --by "<your name>"
//
// Never calls a provider. Needs SUPABASE_DB_URL (migrations through 116 applied).
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { analyticsSql, loadFunnel, loadTraction, markTest, tractionText, type TestTarget } from "@haggle/engine";

export type TractionCommand =
  | { kind: "report"; json: boolean; since?: Date }
  | { kind: "mark"; target: TestTarget; marked: boolean; reason: string; by: string };

const arg = (argv: string[], name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

/** Validate a command line (pure). */
export function planTraction(argv: string[]): TractionCommand {
  const [kind] = argv;
  if (kind === "report") {
    const s = arg(argv, "since");
    if (s !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("--since must be YYYY-MM-DD");
    return { kind, json: argv.includes("--json"), ...(s ? { since: new Date(`${s}T00:00:00Z`) } : {}) };
  }
  if (kind === "mark-test" || kind === "unmark-test") {
    const ws = arg(argv, "workspace");
    const job = arg(argv, "job");
    if (!!ws === !!job) throw new Error("give exactly one of --workspace ws_... or --job job_...");
    if (ws && !/^ws_[a-z0-9_]{3,40}$/.test(ws)) throw new Error("--workspace must be a workspace id like ws_acme");
    if (job && !/^job_[A-Za-z0-9]{6,40}$/.test(job)) throw new Error("--job must be a job id like job_...");
    const reason = (arg(argv, "reason") ?? "").trim();
    const by = (arg(argv, "by") ?? "").trim();
    if (reason.length < 3 || reason.length > 300) throw new Error("--reason is required (3-300 chars): why this is (or isn't) test traffic");
    if (by.length < 2 || by.length > 80) throw new Error("--by is required: who is marking it");
    return { kind: "mark", target: ws ? { kind: "workspace", id: ws } : { kind: "job", id: job! }, marked: kind === "mark-test", reason, by };
  }
  throw new Error("usage: traction.ts report [--json] [--since YYYY-MM-DD] | mark-test|unmark-test (--workspace ws_... | --job job_...) --reason \"...\" --by \"<name>\"");
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planTraction(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const sql = analyticsSql(url);
  try {
    if (cmd.kind === "mark") {
      await markTest(sql, cmd.target, cmd.marked, cmd.reason, cmd.by);
      console.log(`${cmd.target.kind} ${cmd.target.id} ${cmd.marked ? "marked as test: excluded from traction" : "unmarked: counts as real traction again"} (${cmd.reason}; by ${cmd.by}).`);
      return;
    }
    const [t, f] = await Promise.all([loadTraction(sql), loadFunnel(sql, cmd.since ? { since: cmd.since } : {})]);
    console.log(cmd.json ? JSON.stringify({ ...t, funnel: { jobs: f.jobs, reached: f.reached, stopped: f.stopped } }, null, 2) : tractionText(t, f));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/traction.ts")) {
  main().catch((e) => {
    console.error(`traction failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
