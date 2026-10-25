// CI runs every release gate (docs/deployment.md §3), and the migration checks need no list edits
// when a migration is added: the ledger, verify-migrations.sh, migration-compat.sh and the launch
// gate all read supabase/migrations. The one hand-kept list (verify-migrations.sh ISOLATION_BASES)
// must name real migrations, in order.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findMigrationsDir, isEngineMigration, repoMigrations } from "@haggle/engine";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const CI = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n"); // a CRLF checkout (Windows autocrlf)
const runs = [...CI.matchAll(/^\s+run:\s*(.+)$/gm)].map((m) => m[1]!.trim()).concat([...CI.matchAll(/^\s+run:\s*\|\n((?:\s{10,}.+\n?)+)/gm)].flatMap((m) => m[1]!.split("\n").map((l) => l.trim()).filter(Boolean)));

describe("CI runs every release gate", () => {
  for (const [gate, re] of [
    ["install from the lockfile", /^npm ci$/],
    ["dependency tree consistent", /^npm ls --all/],
    ["secret scan", /secret-scan\.ts$/],
    ["env manifest doc freshness", /env-manifest\.ts --check docs\/env-manifest\.md$/],
    ["shellcheck", /^shellcheck -x/],
    ["typecheck", /^npm run typecheck$/],
    ["build", /^npm run build$/],
    ["launch gate (offline)", /launch-gate\.ts --target development --skip-config$/],
    ["unit and end-to-end tests", /^npx vitest run$/],
    ["mock-mode smoke against the built server", /^scripts\/smoke-local\.sh$/],
    ["migrations + SQL assertions + isolation", /^scripts\/verify-migrations\.sh$/],
    ["migration upgrade compatibility", /^scripts\/migration-compat\.sh$/],
    ["Postgres suite + ledger", /^scripts\/test-postgres\.sh$/],
  ] as const) {
    it(gate, () => expect(runs.some((r) => re.test(r)), `${gate}: no CI step runs ${re}`).toBe(true));
  }

  it("CI never gets a secret and never deploys", () => {
    expect(CI).not.toMatch(/secrets\./);
    expect(CI).not.toMatch(/mcp-use deploy|staging-release\.ts --execute/);
    expect(CI).toMatch(/HAGGLE_MODE: mock/);
    expect(CI).toMatch(/permissions:\s*\n\s*contents: read/);
  });

  it("the Postgres step runs every PG-gated apps/mcp test by glob (a new *.pg.test.ts needs no edit)", () => {
    expect(readFileSync(join(ROOT, "scripts", "test-postgres.sh"), "utf8")).toMatch(/vitest" run apps\/mcp\/tests\/\*\.pg\.test\.ts$/m);
  });

  it("the build runs before the tests and the smoke (the e2e suites start the built server)", () => {
    const at = (re: RegExp) => runs.findIndex((r) => re.test(r));
    expect(at(/^npm run build$/)).toBeLessThan(at(/^npx vitest run$/));
    expect(at(/^npm run build$/)).toBeLessThan(at(/smoke-local\.sh/));
  });
});

describe("migration lists come from the directory", () => {
  const dir = findMigrationsDir(import.meta.dirname)!;
  const engine = repoMigrations(dir).map((m) => m.name).filter(isEngineMigration);
  const vm = readFileSync(join(ROOT, "scripts", "verify-migrations.sh"), "utf8");
  const compat = readFileSync(join(ROOT, "scripts", "migration-compat.sh"), "utf8");

  it("ISOLATION_BASES (the one hand-kept list) names existing engine migrations, ascending", () => {
    const bases = vm.match(/^ISOLATION_BASES="([\d ]+)"$/m)?.[1]?.split(" ").filter(Boolean) ?? [];
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(engine.some((n) => n.startsWith(`${b}_`)), `ISOLATION_BASES names ${b}, which has no engine migration`).toBe(true);
    expect([...bases].map(Number)).toEqual([...bases].map(Number).sort((a, b) => a - b));
    // Sprint 5's files (118, 119, 121, 122) are checked alone on 100-117.
    expect(bases.at(-1)).toBe("117");
  });

  it("no script names a specific later migration file (new files need no list edits)", () => {
    for (const [name, src] of [["verify-migrations.sh", vm], ["migration-compat.sh", compat]] as const) {
      const named = [...src.replace(/^\s*#.*$/gm, "").matchAll(/\b1(\d\d)_engine_[a-z0-9_]+\.sql/g)].map((m) => m[0]);
      // 102 (the live database's checkpoint) and 111 (the ledger) are fixed points of the design.
      expect(named.filter((n) => !/^(102|111)_/.test(n)), name).toEqual([]);
    }
    const ledger = readFileSync(join(ROOT, "packages", "engine", "src", "ops", "migrations.ts"), "utf8");
    expect([...ledger.matchAll(/\b1\d\d_engine_[a-z0-9_]+\.sql/g)].map((m) => m[0]).filter((n) => n !== "111_engine_ops.sql")).toEqual([]);
  });
});
