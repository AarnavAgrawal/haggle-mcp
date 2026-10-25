// The migration ledger on a real Postgres (scripts/test-postgres.sh sets HAGGLE_TEST_DATABASE_URL to a
// throwaway database with every migration applied): the ledger script's status / backfill / record,
// drift refusal, the repository's read, and /ready's migrations check. Skipped without a database.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareMigrations, findMigrationsDir, isEngineMigration, ledgerClient, PostgresRepository, readLedger, recordMigrations, repoMigrations } from "@haggle/engine";
import { migrationsCheck } from "../src/health.ts";
import { planMigrations, selectForRecord } from "../scripts/migrations.ts";

const URL_ = process.env.HAGGLE_TEST_DATABASE_URL;
const files = repoMigrations(findMigrationsDir(import.meta.dirname)!);
// tsx through node: the .bin shim can't be spawned without a shell on Windows.
const TSX_CLI = join(import.meta.dirname, "..", "..", "..", "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(import.meta.dirname, "..", "scripts", "migrations.ts");
const cli = (...args: string[]) => spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], { env: { PATH: process.env.PATH ?? "", SUPABASE_DB_URL: URL_! }, encoding: "utf8", timeout: 60_000 });

describe.skipIf(!URL_)("migration ledger on Postgres", () => {
  const sql = URL_ ? ledgerClient(URL_) : null!;
  const repo = URL_ ? new PostgresRepository(URL_, { max: 1 }) : null!;
  afterAll(async () => { await sql?.end({ timeout: 5 }); await repo?.close(); });

  it("a freshly migrated database: 111 recorded itself without a checksum, everything else unrecorded", async () => {
    const ledger = await readLedger(sql);
    expect(ledger).toEqual([expect.objectContaining({ name: "111_engine_ops.sql", checksum: null })]);
    const s = compareMigrations(files, ledger, isEngineMigration);
    expect(s).toMatchObject({ ok: false, unverified: ["111_engine_ops.sql"] });
    expect(s.pending).toContain("100_engine_core.sql");
    expect(await migrationsCheck({ repo, database: "postgres" }, files)).toMatchObject({ ok: false, unverified: ["111_engine_ops.sql"] });
    const r = cli("verify");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/engine migrations: NOT OK/);
  }, 60_000);

  it("record needs --confirm; backfill records every file through the named one; then status is OK and /ready agrees", async () => {
    expect(() => planMigrations(["backfill", "--through", "111_engine_ops.sql"])).toThrow(/--confirm/);
    const last = files.filter((f) => isEngineMigration(f.name)).at(-1)!.name;
    const r = cli("backfill", "--through", last, "--confirm");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/recorded: 100_engine_core\.sql/);
    const status = cli("status", "--json");
    expect(JSON.parse(status.stdout)).toMatchObject({ ledger: "present", ok: true, drift: [], unverified: [] });
    expect(await repo.listAppliedMigrations()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "100_engine_core.sql", checksum: files.find((f) => f.name === "100_engine_core.sql")!.checksum })]));
    expect(await migrationsCheck({ repo, database: "postgres" }, files)).toMatchObject({ ok: true, pending: [], drift: [] });
    expect(r.stdout + status.stdout).not.toMatch(/postgres:\/\//);
  }, 60_000);

  it("a changed file is drift: reported, refused by record, only accepted explicitly", async () => {
    const changed = [{ name: "100_engine_core.sql", checksum: "0".repeat(64) }];
    expect(await recordMigrations(sql, changed, "test")).toMatchObject({ recorded: [], refused: ["100_engine_core.sql"] });
    await recordMigrations(sql, changed, "test", { acceptDrift: true });
    expect(await migrationsCheck({ repo, database: "postgres" }, files)).toMatchObject({ ok: false, drift: ["100_engine_core.sql"] });
    expect(cli("verify").status).toBe(1);
    // Put the real checksum back (operator accepted the repo's file after checking the database).
    expect(cli("record", "100_engine_core.sql", "--confirm", "--accept-drift").status).toBe(0);
    expect(await migrationsCheck({ repo, database: "postgres" }, files)).toMatchObject({ ok: true });
    expect(selectForRecord(planMigrations(["record", "111_engine_ops.sql", "--confirm"]) as never, files).map((f) => f.name)).toEqual(["111_engine_ops.sql"]);
    expect(() => selectForRecord(planMigrations(["record", "999_engine_nope.sql", "--confirm"]) as never, files)).toThrow(/not in supabase\/migrations/);
  }, 60_000);

  it("a database ahead of the checkout: verify fails (UNEXPECTED) unless --allow-ahead; /ready reports it and stays ok", async () => {
    await sql`insert into engine_migrations (name, checksum, recorded_by) values ('199_engine_from_newer_build.sql', ${"a".repeat(64)}, 'test')`;
    try {
      const v = cli("verify");
      expect(v.status).toBe(1);
      expect(v.stdout).toMatch(/UNEXPECTED: engine migration in the database but not in this checkout[\s\S]*199_engine_from_newer_build\.sql/);
      expect(cli("verify", "--allow-ahead").status).toBe(0);
      expect(await migrationsCheck({ repo, database: "postgres" }, files)).toMatchObject({ ok: true, unexpected: ["199_engine_from_newer_build.sql"], database_ahead: true });
    } finally {
      await sql`delete from engine_migrations where name = '199_engine_from_newer_build.sql'`;
    }
  }, 60_000);
});
