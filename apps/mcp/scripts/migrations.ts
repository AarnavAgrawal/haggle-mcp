// Migration ledger (engine_migrations, migration 111): which supabase/migrations files a database
// has, and whether any applied file has changed since (checksum drift). Applying a migration stays
// an operator step (psql -1 -f, or the SQL editor); this records it afterwards. See docs/deployment.md.
//
//   node --env-file=<env> apps/mcp/scripts/migrations.ts status  [--db-url-env SUPABASE_DB_URL] [--json]
//   node --env-file=<env> apps/mcp/scripts/migrations.ts verify  [--db-url-env ...]      exit 1 unless every engine migration is recorded and matches
//   node --env-file=<env> apps/mcp/scripts/migrations.ts record 111_engine_ops.sql [...] --confirm
//   node --env-file=<env> apps/mcp/scripts/migrations.ts backfill --through 111_engine_ops.sql --confirm
//
// record / backfill write only engine_migrations rows (the operator asserts those files were applied);
// an existing row with a different checksum is refused unless --accept-drift. status and verify only read.
// A production database (HAGGLE_PROD_DB_HOSTS) is refused unless HAGGLE_ENV=production or
// HAGGLE_ALLOW_PROD_DB=true (src/config.ts).
import { compareMigrations, findMigrationsDir, isEngineMigration, ledgerClient, readLedger, recordMigrations, repoMigrations, type MigrationStatus, type RepoMigration } from "@haggle/engine";
import { prodDbGuard } from "../src/config.ts";

export type MigrationsCommand =
  | { kind: "status" | "verify"; urlEnv: string; json: boolean }
  | { kind: "record"; urlEnv: string; names: string[]; acceptDrift: boolean }
  | { kind: "backfill"; urlEnv: string; through: string; acceptDrift: boolean };

const arg = (argv: string[], name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Validate a command line (pure). */
export function planMigrations(argv: string[]): MigrationsCommand {
  const [kind, ...rest] = argv;
  const urlEnv = arg(argv, "db-url-env") ?? "SUPABASE_DB_URL";
  if (!/^[A-Z][A-Z0-9_]{2,60}$/.test(urlEnv)) throw new Error("--db-url-env must name an environment variable");
  if (kind === "status" || kind === "verify") return { kind, urlEnv, json: argv.includes("--json") };
  const acceptDrift = argv.includes("--accept-drift");
  if (kind !== "record" && kind !== "backfill") throw new Error("command must be one of: status, verify, record, backfill");
  if (!argv.includes("--confirm")) throw new Error(`${kind} writes the ledger: add --confirm once the migrations really are applied`);
  if (kind === "record") {
    const names = rest.filter((a, i) => !a.startsWith("--") && !(rest[i - 1] === "--db-url-env"));
    if (!names.length) throw new Error("record needs one or more migration file names, e.g. 111_engine_ops.sql");
    for (const n of names) if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(n)) throw new Error(`not a migration file name: ${n}`);
    return { kind, urlEnv, names, acceptDrift };
  }
  const through = arg(argv, "through") ?? "";
  if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(through)) throw new Error("backfill needs --through <migration file>, the last one applied");
  return { kind, urlEnv, through, acceptDrift };
}

/** Which repo files a command records (pure). Unknown names are an error. */
export function selectForRecord(cmd: Extract<MigrationsCommand, { kind: "record" | "backfill" }>, repo: RepoMigration[]): RepoMigration[] {
  if (cmd.kind === "backfill") {
    if (!repo.some((m) => m.name === cmd.through)) throw new Error(`${cmd.through} is not in supabase/migrations`);
    return repo.filter((m) => m.name <= cmd.through);
  }
  return cmd.names.map((n) => {
    const m = repo.find((r) => r.name === n);
    if (!m) throw new Error(`${n} is not in supabase/migrations`);
    return m;
  });
}

export function formatStatus(s: MigrationStatus): string {
  const line = (label: string, l: string[]) => (l.length ? [`${label} (${l.length}):`, ...l.map((n) => `  ${n}`)] : []);
  return [
    `ledger: ${s.ledger}${s.ledger === "absent" ? " (apply 111_engine_ops.sql, then backfill)" : ""}`,
    ...line("applied, checksum matches", s.applied),
    ...line("DRIFT: applied file has changed in the repo", s.drift),
    ...line("recorded without a checksum (run record)", s.unverified),
    ...line("not recorded (pending, or applied before the ledger: backfill)", s.pending),
    ...line("in the ledger but not in this checkout", s.unknown),
    `engine migrations: ${s.ok ? "OK" : "NOT OK"}`,
  ].join("\n");
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planMigrations(argv);
  const url = process.env[cmd.urlEnv]?.trim();
  if (!url) throw new Error(`${cmd.urlEnv} is not set`);
  const refused = prodDbGuard(process.env, [cmd.urlEnv]);
  if (refused.length) throw new Error(refused.join("; "));
  const dir = findMigrationsDir(new URL("../../..", import.meta.url).pathname) ?? findMigrationsDir();
  if (!dir) throw new Error("supabase/migrations not found (run from a checkout of the repo)");
  const repo = repoMigrations(dir);
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim() || undefined;
  const sql = ledgerClient(url, schema);
  try {
    if (cmd.kind === "status" || cmd.kind === "verify") {
      const s = compareMigrations(repo, await readLedger(sql), isEngineMigration);
      console.log(cmd.json ? JSON.stringify(s) : formatStatus(s));
      if (cmd.kind === "verify" && !s.ok) process.exitCode = 1;
      return;
    }
    const write = cmd as Extract<MigrationsCommand, { kind: "record" | "backfill" }>;
    const r = await recordMigrations(sql, selectForRecord(write, repo), `migrations.ts ${write.kind}`, { acceptDrift: write.acceptDrift });
    console.log([`recorded: ${r.recorded.join(", ") || "none"}`, `unchanged: ${r.unchanged.join(", ") || "none"}`, ...(r.refused.length ? [`REFUSED (checksum differs; check the database, then --accept-drift): ${r.refused.join(", ")}`] : [])].join("\n"));
    if (r.refused.length) process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/migrations.ts")) {
  main().catch((e) => {
    // The message names variables and files only; the database URL is never printed.
    console.error(`migrations failed: ${(e as Error).message.replace(/postgres(ql)?:\/\/\S+/g, "[database url]")}`);
    process.exit(1);
  });
}
