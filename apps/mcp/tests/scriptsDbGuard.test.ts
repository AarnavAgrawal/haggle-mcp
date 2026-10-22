// Every operator script that can open a database refuses a production database outside
// HAGGLE_ENV=production (src/config.ts prodDbGuard). Enumerates apps/mcp/scripts/*.ts, so a new
// script that connects without the guard fails here; then runs the guarded scripts for real.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(import.meta.dirname, "..", "scripts");
const TSX = join(import.meta.dirname, "..", "..", "..", "node_modules", ".bin", "tsx");
const PROD_DB = "postgres://postgres.prodref123:hunter2pw@aws-0-us-west-1.pooler.supabase.com:5432/postgres";

/** Can this script source open a database connection? */
export const touchesDatabase = (src: string) =>
  /\bPostgresRepository\b|from\s+["']postgres["']|\bledgerClient\b|\bSUPABASE_DB_URL\b|\bHAGGLE_MOCK_DATABASE_URL\b/.test(src.replace(/^\s*\/\/.*$/gm, ""));
/** Guarded: the side-effect import as the first import, or an explicit prodDbGuard / guardScriptDatabase call. */
export function guarded(src: string): boolean {
  const firstImport = src.match(/^import\s.*$/m)?.[0] ?? "";
  if (/^import\s+["']\.\/dbGuard\.ts["']/.test(firstImport)) return true;
  return /\b(prodDbGuard|guardScriptDatabase)\s*\(/.test(src);
}

describe("operator scripts and the production-database guard", () => {
  const scripts = readdirSync(DIR).filter((f) => f.endsWith(".ts") && f !== "dbGuard.ts");

  it("the detectors work (a new unguarded script would fail)", () => {
    expect(touchesDatabase(`import { PostgresRepository } from "@haggle/engine";`)).toBe(true);
    expect(touchesDatabase(`import postgres from "postgres";`)).toBe(true);
    expect(touchesDatabase(`// mentions SUPABASE_DB_URL in a comment only\nconst x = 1;`)).toBe(false);
    expect(guarded(`import "./dbGuard.ts";\nimport { PostgresRepository } from "@haggle/engine";`)).toBe(true);
    expect(guarded(`import { PostgresRepository } from "@haggle/engine";\nimport "./dbGuard.ts";`)).toBe(false);
    expect(guarded(`import { prodDbGuard } from "../src/config.ts";\nconst refused = prodDbGuard(process.env, [k]);`)).toBe(true);
  });

  it("every script that can open a database is guarded", () => {
    const db = scripts.filter((f) => touchesDatabase(readFileSync(join(DIR, f), "utf8")));
    expect(db).toEqual(expect.arrayContaining(["job-ops.ts", "migrations.ts", "workspace-admin.ts", "workspace-create.ts", "launch-gate.ts"]));
    const unguarded = db.filter((f) => !guarded(readFileSync(join(DIR, f), "utf8")));
    expect(unguarded, "add `import \"./dbGuard.ts\";` as the first import (or call prodDbGuard before connecting)").toEqual([]);
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

  it("launch-gate refuses to read a production ledger from staging", () => {
    const r = run("launch-gate.ts", ["--target", "staging", "--db-url-env", "TARGET_DB_URL", "--skip-config", "--skip-build"], { TARGET_DB_URL: PROD_DB, HAGGLE_PROD_DB_HOSTS: "prodref123" });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL\s+migrations.*production database/);
    expect(r.stderr + r.stdout).not.toMatch(/hunter2pw/);
  }, 60_000);
});
