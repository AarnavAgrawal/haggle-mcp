// Sprint 2026-10-22: the operator scripts are documented as `node scripts/<x>.ts`, which runs Node's
// type stripping. TypeScript-only syntax anywhere in their import graph (parameter properties,
// enums) made every one of them crash with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX before doing anything.
// Each is run with no arguments and no database: it must load and fail on its own argument check.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "..");
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

describe("operator scripts load under plain node", () => {
  for (const s of ["workspace-admin", "workspace-create", "job-ops", "migrations", "traction", "ops-report"]) {
    it(s, () => {
      const r = spawnSync(process.execPath, [`scripts/${s}.ts`], { cwd: APP, env, encoding: "utf8", timeout: 60_000 });
      expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
      expect(r.stderr).toMatch(new RegExp(`${s} failed:`));
    }, 90_000);
  }
  // Sprint 4 deployment scripts: load under plain node; with no arguments they print usage (or run
  // their offline default) and never crash on syntax.
  for (const [s, status, out] of [["launch-gate", 2, /usage: launch-gate\.ts/], ["env-manifest", 0, /\| Variable \| Purpose/], ["secret-scan", 0, /secret scan: clean/], ["smoke", 1, /usage: smoke\.ts/]] as const) {
    it(s, () => {
      const r = spawnSync(process.execPath, [`scripts/${s}.ts`], { cwd: APP, env, encoding: "utf8", timeout: 60_000 });
      expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
      expect(r.status).toBe(status);
      expect(r.stdout + r.stderr).toMatch(out);
    }, 90_000);
  }
});
