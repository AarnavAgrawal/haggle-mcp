// The migration ledger's expected list comes from the supabase/migrations directory, so new files
// (sprint 4: 112, 113, 115, 116, 117, maybe 114) are expected as soon as they exist; a database with
// an engine migration this checkout lacks is "unexpected"; the directory itself is checked for
// duplicate numbers and misnamed files.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compareMigrations, findMigrationsDir, isEngineMigration, LEDGER_MIGRATION, migrationFileProblems, repoMigrations, type LedgerRow, type RepoMigration } from "../src/index.ts";

const at = "2026-10-22T00:00:00.000Z";
const ledgerOf = (l: RepoMigration[]): LedgerRow[] => l.map((m) => ({ name: m.name, checksum: m.checksum, applied_at: at }));
const dirs: string[] = [];
const fakeDir = (names: string[]) => {
  const d = mkdtempSync(join(tmpdir(), "haggle-mig-"));
  dirs.push(d);
  for (const n of names) writeFileSync(join(d, n), `-- ${n}\nselect 1;\n`);
  return d;
};
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const BASE = ["100_engine_core.sql", "101_engine_channels.sql", "102_engine_stripe.sql", "103_engine_parity.sql", "104_engine_read_indexes.sql", "105_engine_security.sql", "106_engine_pilot.sql", "108_engine_tenancy.sql", "109_engine_reliability.sql", "110_engine_booking.sql", "111_engine_ops.sql", "200_brain_profiles.sql", "201_brain_profiles_grants.sql"];
const SPRINT4 = ["112_engine_inbound_review.sql", "113_engine_purchasing.sql", "115_engine_security.sql", "116_engine_analytics.sql", "117_engine_ops.sql"];

describe("migration ledger: expected list, unexpected rows, file checks", () => {
  it("the expected list is the directory: new files are pending until recorded (nothing hard-coded)", () => {
    const before = repoMigrations(fakeDir(BASE));
    const after = repoMigrations(fakeDir([...BASE, ...SPRINT4]));
    const ledger = ledgerOf(before.filter((m) => isEngineMigration(m.name)));
    expect(compareMigrations(before, ledger, isEngineMigration)).toMatchObject({ ok: true, pending: ["200_brain_profiles.sql", "201_brain_profiles_grants.sql"], unexpected: [] });
    const s = compareMigrations(after, ledger, isEngineMigration);
    expect(s.ok).toBe(false);
    expect(s.pending.filter(isEngineMigration)).toEqual(SPRINT4);
    expect(compareMigrations(after, ledgerOf(after.filter((m) => isEngineMigration(m.name))), isEngineMigration).ok).toBe(true);
  });

  it("an engine migration in the database but not in this checkout is unexpected: not ok unless allowed (rollback)", () => {
    const repo = repoMigrations(fakeDir(BASE));
    const ledger = [...ledgerOf(repo.filter((m) => isEngineMigration(m.name))), { name: "117_engine_ops.sql", checksum: "f".repeat(64), applied_at: at }, { name: "299_brain_future.sql", checksum: "e".repeat(64), applied_at: at }];
    const s = compareMigrations(repo, ledger, isEngineMigration);
    expect(s).toMatchObject({ ok: false, unknown: ["117_engine_ops.sql", "299_brain_future.sql"], unexpected: ["117_engine_ops.sql"], pending: ["200_brain_profiles.sql", "201_brain_profiles_grants.sql"] });
    expect(compareMigrations(repo, ledger, isEngineMigration, { allowUnexpected: true })).toMatchObject({ ok: true, unexpected: ["117_engine_ops.sql"] });
    // A brain (2xx) row the engine doesn't know never blocks the engine.
    expect(compareMigrations(repo, ledger.filter((r) => r.name !== "117_engine_ops.sql"), isEngineMigration).ok).toBe(true);
    // Unrestricted (every file required): any unknown row is unexpected.
    expect(compareMigrations(repo, ledger).unexpected).toEqual(["117_engine_ops.sql", "299_brain_future.sql"]);
    expect(compareMigrations(repo, null)).toMatchObject({ ledger: "absent", unexpected: [], ok: false });
  });

  it("duplicate numbers, misnamed files and non-engine 1xx files are reported", () => {
    expect(migrationFileProblems(fakeDir([...BASE, ...SPRINT4]))).toEqual([]);
    expect(migrationFileProblems(fakeDir([...BASE, "112_engine_inbound_review.sql", "112_engine_purchasing.sql", "114-deploy.sql", "118_brain_wrong_range.sql"]))).toEqual([
      "114-deploy.sql: not a migration file name (NNN_name.sql, lower case)",
      "migration number 112 is used by 112_engine_inbound_review.sql and 112_engine_purchasing.sql",
      "118_brain_wrong_range.sql: 1xx migrations must be named 1NN_engine_<area>.sql",
    ]);
  });

  it("this repo's supabase/migrations is consistent and includes the ledger", () => {
    const dir = findMigrationsDir(import.meta.dirname)!;
    expect(migrationFileProblems(dir)).toEqual([]);
    expect(repoMigrations(dir).map((m) => m.name)).toContain(LEDGER_MIGRATION);
  });
});
