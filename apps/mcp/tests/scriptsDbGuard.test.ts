// Every operator, migration and release script that can open a database refuses a production
// database outside HAGGLE_ENV=production (src/config.ts prodDbGuard). Enumerates, recursively,
// apps/mcp/scripts, packages/engine/scripts and the root scripts/ tree (TypeScript, JavaScript and
// shell), so a new script that connects without the guard fails here, whoever adds it (sprint 5:
// pilot-preflight.ts, metrics.ts, pilot-benchmark.ts, staging-release.ts, ...). Then runs guarded
// scripts for real against a production-looking URL (refused before any connection).
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(import.meta.dirname, "..", "scripts");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const PROD_DB = "postgres://postgres.prodref123:hunter2pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
/** Where scripts live. A new directory of scripts belongs here. */
const SCRIPT_DIRS = ["apps/mcp/scripts", "packages/engine/scripts", "scripts"];
/**
 * Scripts that connect without the guard, on purpose, with the reason. Adding one here is a
 * reviewed decision; anything else that connects must be guarded.
 */
const EXEMPT: Record<string, string> = {
  "apps/mcp/scripts/dbGuard.ts": "the guard itself",
  "scripts/spikes/preflight.ts": "legacy pre-v5 credential spike: one read-only session (default_transaction_read_only = on), no writes; not an operator script",
};

const CODE = /\.(ts|mts|mjs|js)$/;
function walk(abs: string): string[] {
  return readdirSync(abs, { withFileTypes: true }).flatMap((d) => d.name === "node_modules" || d.name.startsWith(".") ? [] : d.isDirectory() ? walk(join(abs, d.name)) : CODE.test(d.name) || d.name.endsWith(".sh") ? [join(abs, d.name)] : []);
}
const stripComments = (src: string, shell: boolean) => (shell ? src.replace(/^\s*#.*$/gm, "") : src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""));
/** A database URL variable: SUPABASE_DB_URL, HAGGLE_MOCK_DATABASE_URL, a --db-url-env target, the CI admin URL. */
const DB_URL_VAR = /\b[A-Z][A-Z0-9_]*(?:_DB_URL|DATABASE_URL|PG_ADMIN_URL)\b/;

/** Can this script source open a database connection? */
export const touchesDatabase = (src: string) =>
  /\bPostgresRepository\b|from\s+["']postgres["']|\bledgerClient\b|\bpg_dump\b|\bpsql\b/.test(stripComments(src, false)) || DB_URL_VAR.test(stripComments(src, false));
/** Guarded: the side-effect import as the first import, or an explicit prodDbGuard / guardScriptDatabase call. */
export function guarded(src: string): boolean {
  const firstImport = src.match(/^import\s.*$/m)?.[0] ?? "";
  if (/^import\s+["'](?:\.\.?\/)+(?:[\w.-]+\/)*dbGuard\.ts["']/.test(firstImport)) return true;
  return /\b(prodDbGuard|guardScriptDatabase)\s*\(/.test(src);
}

/** A shell script that runs psql / pg_dump or reads a database URL from its environment. */
export const shellTouchesDatabase = (src: string) => {
  const s = stripComments(src, true);
  return /\b(?:psql|pg_dump|pg_restore)\b/.test(s) || new RegExp(`\\$\\{?${DB_URL_VAR.source.replace(/^\\b/, "")}`).test(s);
};
/**
 * Guarded shell: sources pg-common.sh (whose pg_start refuses any server but localhost / the CI
 * service), or uses only throwaway local databases: no database URL read from the environment and
 * every postgres:// literal on 127.0.0.1 / localhost.
 */
export function shellGuarded(src: string): boolean {
  const s = stripComments(src, true);
  if (/^\s*(?:\.|source)\s+["']?\$\{?ROOT\}?\/scripts\/pg-common\.sh/m.test(s) || /HAGGLE_PG_ADMIN_URL must point at a local/.test(s)) return true;
  const readsUrl = new RegExp(`\\$\\{?${DB_URL_VAR.source.replace(/^\\b/, "")}`).test(s);
  const literals = s.match(/postgres(?:ql)?:\/\/[^\s"']+/g) ?? [];
  return !readsUrl && literals.every((u) => /@(?:127\.0\.0\.1|localhost)[:/]/.test(u));
}

describe("operator scripts and the production-database guard", () => {
  const all = SCRIPT_DIRS.flatMap((d) => walk(join(ROOT, d))).map((abs) => ({ abs, rel: relative(ROOT, abs).replace(/\\/g, "/") }));
  const scripts = readdirSync(DIR).filter((f) => f.endsWith(".ts") && f !== "dbGuard.ts");

  it("the detectors work (a new unguarded script would fail)", () => {
    expect(touchesDatabase(`import { PostgresRepository } from "@haggle/engine";`)).toBe(true);
    expect(touchesDatabase(`import postgres from "postgres";`)).toBe(true);
    expect(touchesDatabase(`spawnSync("pg_dump", ["-Fc", url]);`)).toBe(true);
    expect(touchesDatabase(`const url = env.STAGING_DB_URL;`)).toBe(true);
    expect(touchesDatabase(`// mentions SUPABASE_DB_URL in a comment only\nconst x = 1;`)).toBe(false);
    expect(guarded(`import "./dbGuard.ts";\nimport { PostgresRepository } from "@haggle/engine";`)).toBe(true);
    expect(guarded(`import "../dbGuard.ts";\nimport { PostgresRepository } from "@haggle/engine";`)).toBe(true);
    expect(guarded(`import { PostgresRepository } from "@haggle/engine";\nimport "./dbGuard.ts";`)).toBe(false);
    expect(guarded(`import { prodDbGuard } from "../src/config.ts";\nconst refused = prodDbGuard(process.env, [k]);`)).toBe(true);
    expect(shellTouchesDatabase(`psql "$SUPABASE_DB_URL" -1 -f x.sql`)).toBe(true);
    expect(shellTouchesDatabase(`# psql in a comment\necho hi`)).toBe(false);
    expect(shellGuarded(`psql "$SUPABASE_DB_URL" -f x.sql`)).toBe(false);
    expect(shellGuarded(`pg_dump "\${STAGING_DB_URL}" > b.dump`)).toBe(false);
    expect(shellGuarded(`. "$ROOT/scripts/pg-common.sh"\npg_start x`)).toBe(true);
    expect(shellGuarded(`docker exec -i c psql -U postgres\nX_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:5/postgres" vitest`)).toBe(true);
    expect(shellGuarded(`psql "postgres://u:p@db.prodref.supabase.co:5432/postgres"`)).toBe(false);
  });

  it("enumerates every script directory (a new script is seen wherever it lands)", () => {
    const rels = all.map((s) => s.rel);
    expect(rels).toEqual(expect.arrayContaining(["apps/mcp/scripts/migrations.ts", "scripts/verify-migrations.sh", "scripts/acceptance/job-evidence.mjs"]));
    for (const e of Object.keys(EXEMPT)) expect(rels, `exempt entry ${e} no longer exists: remove it`).toContain(e);
  });

  it("every script that can open a database is guarded (TypeScript, JavaScript and shell, every script directory)", () => {
    const db = all.filter((s) => !Object.hasOwn(EXEMPT, s.rel)).map((s) => ({ ...s, src: readFileSync(s.abs, "utf8") }))
      .filter((s) => (s.rel.endsWith(".sh") ? shellTouchesDatabase(s.src) : touchesDatabase(s.src)));
    expect(db.map((s) => s.rel)).toEqual(expect.arrayContaining(["apps/mcp/scripts/job-ops.ts", "apps/mcp/scripts/migrations.ts", "apps/mcp/scripts/workspace-admin.ts", "apps/mcp/scripts/workspace-create.ts", "apps/mcp/scripts/launch-gate.ts", "scripts/acceptance/job-evidence.mjs", "scripts/pg-common.sh"]));
    const unguarded = db.filter((s) => !(s.rel.endsWith(".sh") ? shellGuarded(s.src) : guarded(s.src))).map((s) => s.rel);
    expect(unguarded, "add `import \"./dbGuard.ts\";` as the first import (or call prodDbGuard before connecting); shell: source scripts/pg-common.sh or use only local databases").toEqual([]);
  });

  const run = (script: string, args: string[], env: Record<string, string>) =>
    spawnSync(TSX, [join(DIR, script), ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8", timeout: 30_000 });

  it("job-ops exits 2 before connecting to a production database outside production", () => {
    const r = run("job-ops.ts", ["list-stuck"], { SUPABASE_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123", HAGGLE_ENV: "staging" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/job-ops\.ts refused: SUPABASE_DB_URL points at a production database but HAGGLE_ENV is staging/);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2pw|prodref123\./);
  }, 60_000);

  it("migrations refuses a production database named by --db-url-env, without printing it", () => {
    const r = run("migrations.ts", ["status", "--db-url-env", "TARGET_DB_URL"], { TARGET_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/TARGET_DB_URL points at a production database/);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2pw/);
  }, 60_000);

  it("job-evidence (acceptance helper) refuses a production database before connecting, without printing it", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "acceptance", "job-evidence.mjs"), "job_x"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", SUPABASE_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123", HAGGLE_ENV: "development" }, encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/job-evidence refused: SUPABASE_DB_URL points at a production database but HAGGLE_ENV is development/);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2pw/);
  }, 60_000);

  it("launch-gate refuses to read a production ledger from staging", () => {
    const r = run("launch-gate.ts", ["--target", "staging", "--db-url-env", "TARGET_DB_URL", "--skip-config", "--skip-build"], { TARGET_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+migrations.*production database/);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2pw/);
  }, 60_000);
});
