// Readiness (/ready): can this server do its job right now? Checks the configuration, that the
// database answers, that every engine migration in this build is recorded in the migration ledger
// with a matching checksum, that the brain's table has 202_brain_tenancy's column (outside the ledger),
// which providers are configured, the AI usage meter and stalled jobs.
// Liveness stays /health. Output carries booleans, counts and migration file names only: never a
// value of any variable, a URL, an address or a job's contents. Results are cached briefly so an
// unauthenticated caller can't turn /ready into database load.
import { compareMigrations, findMigrationsDir, isEngineMigration, LEDGER_MIGRATION, repoMigrations, type Alerter, type AiUsageMeter, type AiUsageSnapshot, type PoolStats, type RepoMigration, type Repository, type StalledJobMonitor } from "@haggle/engine";
import { checkConfig, haggleEnv, type HaggleEnv } from "./config.ts";

/** What the runtime hands /ready (built by runtime.ts / live.ts). */
export interface RuntimeOps {
  env: HaggleEnv;
  repo: Pick<Repository, "listRecentJobs" | "listAppliedMigrations">;
  /** "postgres" needs the ledger; "memory" (mock) has no migrations. */
  database: "postgres" | "memory";
  ai?: AiUsageMeter;
  alerts?: Alerter;
  stalled?: StalledJobMonitor;
  /** Postgres pool slot usage (PostgresRepository.poolStats): counts only. */
  pool?: () => PoolStats;
  providers: { inkbox: boolean; anthropic: boolean; payments: "disabled" | "stripe_test" | "manual"; alerts: boolean };
  /**
   * The brain's profile store, when it has a database schema (SupabaseStore.checkSchema: read-only, no
   * rows). Its 2xx migrations are outside the engine ledger, so this is the only check that 202 is there.
   */
  brain?: { checkSchema(): Promise<{ ok: true } | { ok: false; reason: "schema_missing" | "unreachable" }> };
}

export interface ReadyCheck { ok: boolean; [k: string]: unknown }
export interface ReadyReport {
  ready: boolean;
  service: "haggle-mcp";
  env: HaggleEnv;
  mode: "mock" | "live";
  checks: { config: ReadyCheck; database: ReadyCheck; migrations: ReadyCheck; brain: ReadyCheck; providers: ReadyCheck; ai: ReadyCheck; stalled_jobs: ReadyCheck };
}

/** The brain's schema (202_brain_tenancy): reason and fix only, never the store's error text or URL. */
export async function brainCheck(brain: RuntimeOps["brain"]): Promise<ReadyCheck> {
  if (!brain) return { ok: true, schema: "not_applicable" };
  try {
    const r = await withTimeout(brain.checkSchema(), 3_000);
    if (r.ok) return { ok: true, schema: "ok" };
    return r.reason === "schema_missing"
      ? { ok: false, reason: "schema_missing", fix: "apply supabase/migrations/202_brain_tenancy.sql to the brain's database (docs/deployment.md §4)" }
      : { ok: false, reason: "unreachable" };
  } catch (e) {
    return { ok: false, reason: (e as Error)?.message === "timed out" ? "timed_out" : "unreachable" };
  }
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms).unref?.())]);

let repoFiles: { at: number; list: RepoMigration[] | null } | null = null;
/** This build's migration files (read once; null when the deployment carries no supabase/ folder). */
function buildMigrations(): RepoMigration[] | null {
  if (repoFiles) return repoFiles.list;
  const dir = process.env.HAGGLE_MIGRATIONS_DIR?.trim() || findMigrationsDir();
  repoFiles = { at: Date.now(), list: dir ? repoMigrations(dir) : null };
  return repoFiles.list;
}

export async function migrationsCheck(ops: Pick<RuntimeOps, "repo" | "database">, files: RepoMigration[] | null = buildMigrations()): Promise<ReadyCheck> {
  if (ops.database === "memory" || !ops.repo.listAppliedMigrations) return { ok: true, ledger: "not_applicable" };
  const ledger = await ops.repo.listAppliedMigrations();
  if (ledger === null) return { ok: false, ledger: "absent", fix: `apply ${LEDGER_MIGRATION}, then run apps/mcp/scripts/migrations.ts backfill (see docs/deployment.md)` };
  if (!files) {
    // No repo files in this deployment: at least the ledger itself must be recorded.
    const self = ledger.find((r) => r.name === LEDGER_MIGRATION);
    return { ok: !!self?.checksum, ledger: "present", repo_files: "unavailable", recorded: ledger.length };
  }
  // A database ahead of this build (engine migrations it doesn't know) is reported, not fatal: after a
  // rollback to an older build the additive schema still serves it. migrations.ts verify and the
  // launch gate refuse it unless the operator says --allow-ahead.
  const s = compareMigrations(files, ledger, isEngineMigration, { allowUnexpected: true });
  const pick = (l: string[]) => l.filter(isEngineMigration);
  return { ok: s.ok, ledger: "present", applied: s.applied.length, pending: pick(s.pending), drift: pick(s.drift), unverified: pick(s.unverified), unknown: s.unknown.length, unexpected: s.unexpected, ...(s.unexpected.length ? { database_ahead: true } : {}) };
}

function aiCheck(snap: AiUsageSnapshot | null): ReadyCheck {
  if (!snap) return { ok: true, metered: false };
  // A spent daily budget doesn't make the server unready (replies are held for humans), but it shows.
  return { ok: true, metered: true, day: snap.day, calls: snap.calls, tokens_in: snap.tokens_in, tokens_out: snap.tokens_out, refused: snap.refused, limits: snap.limits, daily_tokens_remaining: snap.daily_tokens_remaining, daily_budget_reached: snap.daily_budget_reached, jobs_at_call_limit: snap.jobs_at_call_limit };
}

/** Builds the report. `runtimeError` is the runtime's construction failure, if any (its text is not echoed). */
export async function readiness(input: { mode: "mock" | "live"; ops: RuntimeOps | null; runtimeError?: unknown }, env: Record<string, string | undefined> = process.env): Promise<ReadyReport> {
  const cfg = checkConfig(env);
  const config: ReadyCheck = { ok: cfg.errors.length === 0 && !input.runtimeError, errors: cfg.errors.length, warnings: cfg.warnings.length, ...(cfg.errors.length ? { problems: cfg.errors } : {}), ...(input.runtimeError && !cfg.errors.length ? { runtime: "failed to start (see the server log)" } : {}) };
  const ops = input.ops;
  let database: ReadyCheck = { ok: false, reason: "not_started" };
  let migrations: ReadyCheck = { ok: false, reason: "not_started" };
  if (ops) {
    const t0 = Date.now();
    try {
      await withTimeout(ops.repo.listRecentJobs(1), 3_000);
      database = { ok: true, kind: ops.database, latency_ms: Date.now() - t0 };
    } catch (e) {
      // A saturated pool (PoolBusyError) is not an outage of the database itself: say which.
      database = { ok: false, kind: ops.database, reason: (e as { code?: string })?.code === "EPOOLBUSY" ? "pool_busy" : "unreachable" };
    }
    const pool = ops.pool?.();
    if (pool) database = { ...database, pool };
    if (database.ok) {
      try {
        migrations = await withTimeout(migrationsCheck(ops), 3_000);
      } catch {
        migrations = { ok: false, reason: "ledger_unreadable" };
      }
    } else migrations = { ok: false, reason: "database_unreachable" };
    // Mock rehearsal databases are throwaway: their ledger is reported, never required.
    if (input.mode === "mock") migrations = { ...migrations, ok: true, enforced: false };
  }
  const p = ops?.providers;
  const providers: ReadyCheck = p
    ? { ok: input.mode === "mock" || (p.inkbox && p.anthropic), inkbox: p.inkbox, anthropic: p.anthropic, payments: p.payments, alerts: p.alerts }
    : { ok: false, reason: "not_started" };
  const last = ops?.stalled?.lastReport() ?? null;
  const stalled: ReadyCheck = { ok: true, monitored: !!ops?.stalled, ...(last ? { checked_at: last.at, count: last.count, by_reason: last.jobs.reduce<Record<string, number>>((m, j) => ((m[j.reason] = (m[j.reason] ?? 0) + 1), m), {}) } : {}) };
  const brain: ReadyCheck = ops ? await brainCheck(ops.brain) : { ok: false, reason: "not_started" };
  const checks = { config, database, migrations, brain, providers, ai: aiCheck(ops?.ai?.snapshot() ?? null), stalled_jobs: stalled };
  return { ready: Object.values(checks).every((c) => c.ok), service: "haggle-mcp", env: ops?.env ?? haggleEnv(env), mode: input.mode, checks };
}

let cache: { at: number; report: ReadyReport } | null = null;
/** readiness() cached for `ttlMs` (default 5 s). */
export async function cachedReadiness(input: Parameters<typeof readiness>[0], ttlMs = 5_000): Promise<ReadyReport> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.report;
  const report = await readiness(input);
  cache = { at: Date.now(), report };
  return report;
}

/** Tests only. */
export function resetReadinessCache() {
  cache = null;
  repoFiles = null;
}
