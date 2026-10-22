// staging-release.ts --execute for real, against THROWAWAY databases on the test server
// (scripts/test-postgres.sh sets HAGGLE_TEST_DATABASE_URL; the databases are created and dropped
// here): real psql -1 -f through PG* variables, the real ledger CLI and the real launch gate.
// Two paths: a new, empty staging database (--backfill-through none) and a database at 102 with no
// ledger (the live database's state). Never deploys (no --deploy) and never smokes (no --base-url).
// Skipped without a test database or a psql client on PATH.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { findMigrationsDir, isEngineMigration, ledgerClient, readLedger, repoMigrations } from "@haggle/engine";

const URL_ = process.env.HAGGLE_TEST_DATABASE_URL;
const HAS_PSQL = spawnSync("psql", ["--version"], { encoding: "utf8" }).status === 0;
const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = findMigrationsDir(import.meta.dirname)!;
const ENGINE = repoMigrations(DIR).map((m) => m.name).filter(isEngineMigration);
const LINK = join(ROOT, ".mcp-use", "cloud", "link.json");
const RUN = `${process.pid}_${Date.now().toString(36)}`;

const dbUrl = (name: string) => { const u = new URL(URL_!); u.pathname = `/${name}`; return u.href; };
function envFile(db: string): string {
  const dir = mkdtempSync(join(tmpdir(), "haggle-staging-pg-"));
  const f = join(dir, "staging.env");
  writeFileSync(f, ["HAGGLE_ENV=staging", "HAGGLE_MODE=live", `SUPABASE_DB_URL=${dbUrl(db)}`, "HAGGLE_PROD_DB_HOSTS=prodref-not-this-one", "HAGGLE_PAYMENTS=manual", "INKBOX_API_KEY=unused-test", "INKBOX_WEBHOOK_SECRET=unused-test", "ANTHROPIC_API_KEY=unused-test"].join("\n"));
  return f;
}
const release = (file: string, ...args: string[]) => spawnSync(process.execPath, ["apps/mcp/scripts/staging-release.ts", "--env-file", file, "--execute", "--backup-ref", "throwaway test database", ...args], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8", timeout: 300_000 });

describe.skipIf(!URL_ || !HAS_PSQL)("staging-release --execute on throwaway Postgres databases", () => {
  const admin = URL_ ? postgres(URL_, { max: 1, onnotice: () => {} }) : null!;
  const created: string[] = [];
  let madeLink = false;
  const create = async (name: string) => { await admin.unsafe(`create database "${name}"`); created.push(name); };
  beforeAll(() => {
    // The script refuses a checkout without a Manufact link; a throwaway one (gitignored) if none exists.
    if (!existsSync(LINK)) { mkdirSync(join(ROOT, ".mcp-use", "cloud"), { recursive: true }); writeFileSync(LINK, JSON.stringify({ serverId: "srv_test_staging", serverSlug: "haggle-staging-test" })); madeLink = true; }
  });
  afterAll(async () => {
    for (const d of created) await admin.unsafe(`drop database if exists "${d}" with (force)`).catch(() => undefined);
    await admin.end({ timeout: 5 });
    if (madeLink) rmSync(join(ROOT, ".mcp-use", "cloud"), { recursive: true, force: true });
  });

  it("a new, empty database: every engine migration applied in order, the ledger verified, the launch gate green; a rerun applies nothing", async () => {
    const db = `s5c_fresh_${RUN}`;
    await create(db);
    const file = envFile(db);
    const r = release(file, "--backfill-through", "none");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Apply this checkout's pending engine migrations.* - OK: applied 100_engine_core\.sql/);
    expect(r.stdout).toMatch(/Launch gate for staging - OK/);
    expect(r.stdout + r.stderr).not.toContain(dbUrl(db));
    const sql = ledgerClient(dbUrl(db));
    try { expect((await readLedger(sql))!.filter((l) => isEngineMigration(l.name) && l.checksum).map((l) => l.name)).toEqual(ENGINE); } finally { await sql.end({ timeout: 5 }); }
    const again = release(file);
    expect(again.status, again.stdout).toBe(0);
    expect(again.stdout).toMatch(/nothing pending; ledger verified/);
  }, 300_000);

  it("the live database's state (100-102, no ledger): 111 first, backfill through 102, then 103+ each recorded", async () => {
    const db = `s5c_at102_${RUN}`;
    await create(db);
    const at102 = postgres(dbUrl(db), { max: 1, onnotice: () => {} });
    try {
      for (const f of ENGINE.filter((n) => n <= "102_engine_stripe.sql")) await at102.begin((tx) => tx.unsafe(readFileSync(join(DIR, f), "utf8")));
      await at102.unsafe(readFileSync(join(ROOT, "scripts", "migration-compat", "seed_at_102.sql"), "utf8"));
    } finally { await at102.end({ timeout: 5 }); }
    const file = envFile(db);
    const refused = release(file);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toMatch(/no ledger: pass --backfill-through/);
    const r = release(file, "--backfill-through", "102_engine_stripe.sql");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/applied 111_engine_ops\.sql, 103_engine_parity\.sql/);
    const sql = ledgerClient(dbUrl(db));
    try {
      expect((await readLedger(sql))!.filter((l) => isEngineMigration(l.name) && l.checksum).map((l) => l.name)).toEqual(ENGINE);
      expect((await sql`select workspace_id from jobs where id = 'job_compat_paid'`)[0]).toEqual({ workspace_id: "ws_default" });
    } finally { await sql.end({ timeout: 5 }); }
  }, 300_000);
});
