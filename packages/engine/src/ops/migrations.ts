// The migration ledger (supabase/migrations/111_engine_ops.sql: engine_migrations). Migrations are
// applied by the operator (psql, the Supabase SQL editor); the ledger records which repo files were
// applied, with each file's SHA-256, so a server and an operator can tell what a database is
// missing and whether an applied file has since changed in the repo (drift). Reading never writes;
// recording is an explicit operator step (apps/mcp/scripts/migrations.ts record / backfill).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import postgres from "postgres";

export const LEDGER_MIGRATION = "111_engine_ops.sql";
const NAME = /^\d{3}_[a-z0-9_]+\.sql$/;

export interface RepoMigration { name: string; checksum: string }
export interface LedgerRow { name: string; checksum: string | null; applied_at: string }

export function migrationChecksum(content: string | Buffer): string {
  // Line endings are normalized so a Windows checkout doesn't read as drift.
  return createHash("sha256").update(Buffer.from(content).toString("utf8").replace(/\r\n/g, "\n")).digest("hex");
}

/** supabase/migrations found by walking up from `from` (null when this deployment has no repo files). */
export function findMigrationsDir(from: string = process.cwd()): string | null {
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    const c = join(dir, "supabase", "migrations");
    if (existsSync(c)) return c;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * Problems with the migration files themselves: two files sharing a number (parallel branches both
 * took 1NN), a .sql file whose name the ledger would ignore, a 1xx file not named 1NN_engine_*.
 * Empty = the directory is consistent.
 */
export function migrationFileProblems(dir: string): string[] {
  const all = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const named = all.filter((f) => NAME.test(f));
  const out = all.filter((f) => !NAME.test(f)).map((f) => `${f}: not a migration file name (NNN_name.sql, lower case)`);
  const byNum = new Map<string, string[]>();
  for (const f of named) byNum.set(f.slice(0, 3), [...(byNum.get(f.slice(0, 3)) ?? []), f]);
  for (const [n, fs] of byNum) if (fs.length > 1) out.push(`migration number ${n} is used by ${fs.join(" and ")}`);
  for (const f of named) if (f.startsWith("1") && !isEngineMigration(f)) out.push(`${f}: 1xx migrations must be named 1NN_engine_<area>.sql`);
  return out;
}

export function repoMigrations(dir: string): RepoMigration[] {
  return readdirSync(dir).filter((f) => NAME.test(f)).sort().map((name) => ({ name, checksum: migrationChecksum(readFileSync(join(dir, name))) }));
}

/** Engine migrations (1xx_engine_*) are what this server needs; brain (2xx) files are Aarnav's. */
export const isEngineMigration = (name: string) => /^1\d\d_engine_[a-z0-9_]+\.sql$/.test(name);

export interface MigrationStatus {
  ledger: "present" | "absent";
  /** In the ledger with the repo's checksum. */
  applied: string[];
  /** In the ledger with a different checksum than the repo file now has. */
  drift: string[];
  /** In the ledger without a checksum (e.g. 111 records itself): run `record` to fill it. */
  unverified: string[];
  /** Repo files the ledger doesn't list (not applied, or applied before the ledger: backfill). */
  pending: string[];
  /** Ledger rows with no repo file (applied from another branch, or the file was renamed). */
  unknown: string[];
  /**
   * The required (engine) subset of `unknown`: the database has a migration this build doesn't know
   * (a newer build applied it, it came from another branch, or a file was renamed). Not ok unless
   * `allowUnexpected` (a deliberate rollback to an older build on an additive schema).
   */
  unexpected: string[];
  /** Required migrations all applied, none drifted or unverified, nothing unexpected (unless allowed). */
  ok: boolean;
}

/**
 * Pure comparison. `required` limits which entries make it not ok (default: all): pending, drift,
 * unverified, and (unless `opts.allowUnexpected`) ledger rows this checkout doesn't have.
 */
export function compareMigrations(repo: RepoMigration[], ledger: LedgerRow[] | null, required: (name: string) => boolean = () => true, opts: { allowUnexpected?: boolean } = {}): MigrationStatus {
  if (ledger === null) return { ledger: "absent", applied: [], drift: [], unverified: [], pending: repo.map((m) => m.name), unknown: [], unexpected: [], ok: false };
  const byName = new Map(ledger.map((r) => [r.name, r]));
  const s: MigrationStatus = { ledger: "present", applied: [], drift: [], unverified: [], pending: [], unknown: [], unexpected: [], ok: true };
  for (const m of repo) {
    const r = byName.get(m.name);
    if (!r) s.pending.push(m.name);
    else if (r.checksum === null) s.unverified.push(m.name);
    else if (r.checksum !== m.checksum) s.drift.push(m.name);
    else s.applied.push(m.name);
  }
  const names = new Set(repo.map((m) => m.name));
  s.unknown = ledger.filter((r) => !names.has(r.name)).map((r) => r.name);
  s.unexpected = s.unknown.filter(required);
  s.ok = ![...s.pending, ...s.drift, ...s.unverified, ...(opts.allowUnexpected ? [] : s.unexpected)].some(required);
  return s;
}

type Sql = postgres.Sql;

export function ledgerClient(url: string, schema?: string): Sql {
  if (schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error("invalid database schema name (HAGGLE_DB_SCHEMA)");
  return postgres(url, { max: 1, onnotice: () => {}, idle_timeout: 5, connect_timeout: 10, ...(schema ? { connection: { search_path: schema } } : {}) });
}

/** The ledger rows, or null when engine_migrations doesn't exist yet (111 not applied). Read-only. */
export async function readLedger(sql: Sql): Promise<LedgerRow[] | null> {
  try {
    const rows = await sql<{ name: string; checksum: string | null; applied_at: Date }[]>`select name, checksum, applied_at from engine_migrations order by name`;
    return rows.map((r) => ({ name: r.name, checksum: r.checksum, applied_at: new Date(r.applied_at).toISOString() }));
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return null;
    throw e;
  }
}

/**
 * Records migrations as applied (the operator asserts they were). Fills a missing checksum; an
 * existing different checksum is refused (that is drift) unless `acceptDrift`.
 */
export async function recordMigrations(sql: Sql, entries: RepoMigration[], by: string, opts: { acceptDrift?: boolean } = {}): Promise<{ recorded: string[]; unchanged: string[]; refused: string[] }> {
  const ledger = await readLedger(sql);
  if (ledger === null) throw new Error(`engine_migrations does not exist: apply ${LEDGER_MIGRATION} first`);
  const byName = new Map(ledger.map((r) => [r.name, r]));
  const out = { recorded: [] as string[], unchanged: [] as string[], refused: [] as string[] };
  for (const m of entries) {
    const cur = byName.get(m.name);
    if (cur?.checksum === m.checksum) { out.unchanged.push(m.name); continue; }
    if (cur && cur.checksum !== null && !opts.acceptDrift) { out.refused.push(m.name); continue; }
    await sql`insert into engine_migrations (name, checksum, recorded_by) values (${m.name}, ${m.checksum}, ${by.slice(0, 100)})
      on conflict (name) do update set checksum = excluded.checksum, recorded_by = excluded.recorded_by`;
    out.recorded.push(m.name);
  }
  return out;
}
