// scripts/staging-release.ts: refuses anything but staging, never runs anything in plan mode, gives
// child commands only the env file's variables, keeps the database URL off every command line and
// out of every line it prints, and stops at the first failed step. All with fake commands: nothing
// here connects to a database, Manufact or any provider.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatStaging, parseStagingArgs, pgEnv, runStaging, scrub, type RunResult, type StagingDeps } from "../scripts/staging-release.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const STAGING_DB = "postgres://postgres.stagingref9:st4gingPassw0rdXYZ@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const PROD_DB = "postgres://postgres.prodref123:pr0dPassw0rdXYZ@aws-0-us-west-1.pooler.supabase.com:5432/postgres";
const ENV_FILE = (over: Record<string, string> = {}) => Object.entries({
  HAGGLE_ENV: "staging", HAGGLE_MODE: "live", SUPABASE_DB_URL: STAGING_DB, HAGGLE_PROD_DB_HOSTS: "prodref123", HAGGLE_PAYMENTS: "manual",
  INKBOX_API_KEY: "ik_stagingkeyvalue", INKBOX_WEBHOOK_SECRET: "whsec_stagingsecretvalue", ANTHROPIC_API_KEY: "sk-ant-stagingvalue", HAGGLE_SMOKE_TOKEN: "hgw_stagingtokenvalue_0123456789", ...over,
}).map(([k, v]) => `${k}=${v}`).join("\n");

interface Call { cmd: string; args: string[]; env: Record<string, string | undefined> }
/** Fake commands: git (clean, sha), migrations.ts status/backfill/record/verify, psql, pg_dump, launch-gate, smoke, mcp-use. */
function deps(o: { envFile?: string; link?: object | null; dirty?: boolean; status?: object[]; fail?: RegExp; ready?: string[] } = {}) {
  const calls: Call[] = [];
  const statuses = [...(o.status ?? [{ ledger: "present", pending: [], drift: [], unverified: [], unexpected: [], file_problems: [] }])];
  const ready = [...(o.ready ?? [])];
  const out: string[] = [];
  const d: StagingDeps = {
    readFile: (p) => (p.endsWith("link.json") ? JSON.stringify(o.link) : o.envFile ?? ENV_FILE()),
    exists: (p) => (p.endsWith("link.json") ? o.link !== null : true),
    run: (cmd, args, opts): RunResult => {
      calls.push({ cmd, args, env: opts.env });
      const line = [cmd.split("/").pop(), ...args.map((a) => a.split("/").pop())].join(" ");
      if (o.fail?.test(line)) return { status: 1, stdout: "FAIL  something - detail", stderr: `ERROR: boom at ${STAGING_DB}` };
      if (cmd === "git") return args.includes("rev-parse") ? { status: 0, stdout: "ce4760e12345\n", stderr: "" } : { status: 0, stdout: o.dirty ? " M apps/mcp/index.ts\n" : "", stderr: "" };
      if (line.includes("migrations.ts status")) return { status: 0, stdout: JSON.stringify(statuses.length > 1 ? statuses.shift() : statuses[0]), stderr: "" };
      if (line.includes("launch-gate.ts")) return { status: 0, stdout: "PASS  config\nlaunch gate (staging): OK", stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    },
    fetchJson: async () => ({ build_sha: ready.shift() ?? "ce4760e12345" }),
    sleep: async () => {},
    now: () => new Date("2026-10-22T18:00:00.000Z"),
    repoRoot: "/repo",
    out: (l) => out.push(l),
  };
  return { d, calls, out };
}
const LINK = { organizationId: "org_1", serverId: "srv_staging1", serverSlug: "haggle-staging-x1", sourceType: "upload" };
const opts = (...extra: string[]) => parseStagingArgs(["--env-file", "/secure/staging.env", ...extra]);
const runs = (calls: Call[], re: RegExp) => calls.filter((c) => re.test([c.cmd.split("/").pop(), ...c.args.map((a) => a.split("/").pop())].join(" ")));
const cli = (calls: Call[]) => calls.filter((c) => c.cmd.endsWith("/mcp-use"));
const SECRETS =/st4gingPassw0rd|pr0dPassw0rd|stagingref9:|hgw_stagingtokenvalue|ik_stagingkeyvalue|whsec_staging/;

describe("staging-release: arguments", () => {
  it("needs the env file; --deploy needs --execute and the ids it deploys and rolls back with", () => {
    expect(() => parseStagingArgs([])).toThrow(/usage/);
    expect(() => parseStagingArgs(["--env-file", "x", "--deploy"])).toThrow(/only with --execute/);
    expect(() => parseStagingArgs(["--env-file", "x", "--execute", "--deploy"])).toThrow(/--server-id, --rollback-ref/);
    expect(() => parseStagingArgs(["--env-file", "x", "--backup-dump", "a", "--backup-ref", "b"])).toThrow(/not both/);
    expect(() => parseStagingArgs(["--env-file", "x", "--base-url", "http://insecure.example"])).toThrow(/https/);
    expect(() => parseStagingArgs(["--env-file", "x", "--backfill-through", "102"])).toThrow(/migration file name/);
    expect(opts("--production-server", "srv_prod9").productionServers).toEqual(["calm-spark-ck3qm", "srv_prod9"]);
  });
});

describe("staging-release: plan mode runs nothing", () => {
  it("a staging target plans every step with its exact command and runs only git (read-only)", async () => {
    const { d, calls } = deps({ link: LINK });
    const r = await runStaging(opts("--base-url", "https://haggle-staging.run.mcp-use.com", "--server-id", "srv_staging1"), d);
    expect(r).toMatchObject({ ok: true, mode: "plan", sha: "ce4760e12345", problems: [] });
    expect(calls.every((c) => c.cmd === "git")).toBe(true);
    const text = formatStaging(r);
    expect(text).toMatch(/PLAN \(nothing is run\)/);
    expect(text).toMatch(/node apps\/mcp\/scripts\/launch-gate\.ts --target staging --env-file \/secure\/staging\.env --db-url-env SUPABASE_DB_URL --check-webhooks --webhook-url https:\/\/haggle-staging\.run\.mcp-use\.com\/webhooks\/inkbox/);
    expect(text).toMatch(/mcp-use servers env set srv_staging1 HAGGLE_BUILD_SHA=ce4760e12345/);
    expect(text).toMatch(/mcp-use deploy --json/);
    expect(text).toMatch(/smoke\.ts https:\/\/haggle-staging\.run\.mcp-use\.com --live-readonly/);
    expect(text).toMatch(/Back up the staging database before any DDL - BLOCKED/);
    expect(text).not.toMatch(SECRETS);
  });

  for (const [name, setup, re] of [
    ["HAGGLE_ENV production", { envFile: ENV_FILE({ HAGGLE_ENV: "production" }) }, /HAGGLE_ENV in the env file must be staging/],
    ["mock mode", { envFile: ENV_FILE({ HAGGLE_MODE: "mock" }) }, /HAGGLE_MODE in the env file must be live/],
    ["a production database (by ref)", { envFile: ENV_FILE({ SUPABASE_DB_URL: PROD_DB }) }, /points at a production database.*no override/],
    ["a production database even with HAGGLE_ALLOW_PROD_DB", { envFile: ENV_FILE({ SUPABASE_DB_URL: PROD_DB, HAGGLE_ALLOW_PROD_DB: "true" }) }, /HAGGLE_ALLOW_PROD_DB=true is refused/],
    ["a database named prod", { envFile: ENV_FILE({ SUPABASE_DB_URL: "postgres://u:pw0123456789ab@db.example.com:5432/haggle_prod" }) }, /points at a production database/],
    ["no HAGGLE_PROD_DB_HOSTS", { envFile: ENV_FILE({ HAGGLE_PROD_DB_HOSTS: "" }) }, /HAGGLE_PROD_DB_HOSTS must list/],
    ["Stripe payments", { envFile: ENV_FILE({ HAGGLE_PAYMENTS: "" }) }, /HAGGLE_PAYMENTS must be manual/],
    ["the production Manufact server", { link: { serverId: "srv_x", serverSlug: "calm-spark-ck3qm" } }, /linked to a production Manufact server/],
    ["no Manufact link", { link: null }, /link\.json is missing/],
    ["uncommitted changes", { dirty: true }, /uncommitted changes/],
  ] as const) {
    it(`refuses ${name}, before running anything`, async () => {
      const { d, calls } = deps({ link: LINK, ...setup });
      const r = await runStaging(opts("--execute", "--backup-ref", "pitr 2026-10-22T17:55Z"), d);
      expect(r.ok).toBe(false);
      expect(r.problems.map((p) => p.detail).join("\n")).toMatch(re);
      expect(calls.filter((c) => c.cmd !== "git")).toEqual([]);
      expect(formatStaging(r)).not.toMatch(SECRETS);
    });
  }

  it("refuses a server id that isn't the checkout's link, a production --base-url and a dump inside the repo", async () => {
    const { d } = deps({ link: LINK });
    const r = await runStaging(opts("--server-id", "srv_other", "--base-url", "https://calm-spark-ck3qm.run.mcp-use.com", "--backup-dump", "/repo/backups/staging.dump"), d);
    expect(r.problems.map((p) => p.detail)).toEqual(expect.arrayContaining([expect.stringMatching(/not --server-id/), expect.stringMatching(/--base-url is a production server/), expect.stringMatching(/outside the repository/)]));
  });
});

describe("staging-release: execute", () => {
  it("refuses to touch the schema without a backup", async () => {
    const { d, calls } = deps({ link: LINK });
    const r = await runStaging(opts("--execute"), d);
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.id === "backup")).toMatchObject({ result: "blocked" });
    expect(runs(calls, /^(psql|pg_dump|node)/)).toEqual([]);
  });

  it("the live database's path: dump, create the ledger, backfill through 102, apply and record each pending engine file, verify, gate, smoke", async () => {
    const pending = ["103_engine_parity.sql", "104_engine_read_indexes.sql", "117_engine_ops.sql", "200_brain_profiles.sql"];
    const { d, calls } = deps({ link: LINK, status: [{ ledger: "absent", pending: [], drift: [], unverified: [], unexpected: [], file_problems: [] }, { ledger: "present", pending, drift: [], unverified: [], unexpected: [], file_problems: [] }] });
    process.env.SHELL_ONLY_SECRET = "must-not-reach-children";
    try {
      const r = await runStaging(opts("--execute", "--backup-dump", "/secure/backups/staging.dump", "--backfill-through", "102_engine_stripe.sql", "--base-url", "https://haggle-staging.run.mcp-use.com"), d);
      expect(r.ok, formatStaging(r)).toBe(true);
    } finally {
      delete process.env.SHELL_ONLY_SECRET;
    }
    const seq = calls.filter((c) => c.cmd !== "git").map((c) => [c.cmd.split("/").pop(), ...c.args.map((a) => a.split("/").pop())].join(" ").replace(/^node(\.exe)? /, "").replace(/^\S*node /, ""));
    expect(seq.map((s) => s.replace(/ -X -v ON_ERROR_STOP=1 -1 -f /, " -1 ")).map((s) => s.replace(/^.*?(migrations\.ts|launch-gate\.ts|smoke\.ts)/, "$1"))).toEqual([
      "pg_dump --format=custom --no-owner --no-privileges --schema=public --file staging.dump",
      "migrations.ts status --json",
      "psql -1 111_engine_ops.sql",
      "migrations.ts backfill --through 102_engine_stripe.sql --confirm",
      "migrations.ts record 111_engine_ops.sql --confirm",
      "migrations.ts status --json",
      "psql -1 103_engine_parity.sql", "migrations.ts record 103_engine_parity.sql --confirm",
      "psql -1 104_engine_read_indexes.sql", "migrations.ts record 104_engine_read_indexes.sql --confirm",
      "psql -1 117_engine_ops.sql", "migrations.ts record 117_engine_ops.sql --confirm",
      "migrations.ts verify",
      "launch-gate.ts --target staging --env-file staging.env --db-url-env SUPABASE_DB_URL --check-webhooks --webhook-url inkbox",
      "smoke.ts haggle-staging.run.mcp-use.com --live-readonly",
    ]);
    for (const c of calls) {
      expect(c.args.join(" "), "no database URL on a command line").not.toMatch(/postgres:\/\/|st4gingPassw0rd/);
      expect(c.env.SHELL_ONLY_SECRET, "children get only the env file's variables").toBeUndefined();
    }
    const pg = calls.find((c) => c.cmd === "psql")!;
    expect(pg.env).toMatchObject({ PGHOST: "aws-0-us-west-1.pooler.supabase.com", PGUSER: "postgres.stagingref9", PGPASSWORD: "st4gingPassw0rdXYZ", PGDATABASE: "postgres" });
    expect(pg.env.SUPABASE_DB_URL).toBeUndefined();
    const smokeEnv = calls.find((c) => c.args.some((a) => a.endsWith("smoke.ts")))!.env;
    expect(Object.keys(smokeEnv).sort()).toEqual(["HAGGLE_SMOKE_TOKEN", "HOME", "PATH"]); // least privilege: the token only
    expect(Object.keys(calls.find((c) => c.args.some((a) => a.endsWith("launch-gate.ts")))!.env).sort()).toEqual(["HOME", "PATH"]); // the gate reads the env file itself
    expect(Object.keys(calls.find((c) => c.args.includes("verify"))!.env).sort()).toEqual(["HAGGLE_ENV", "HAGGLE_PROD_DB_HOSTS", "HOME", "PATH", "SUPABASE_DB_URL"]);
    expect(cli(calls)).toEqual([]); // no --deploy: printed only
  });

  it("a new, empty staging database (--backfill-through none): every engine file in order, then one backfill", async () => {
    const all = ["100_engine_core.sql", "101_engine_channels.sql", "111_engine_ops.sql", "117_engine_ops.sql", "200_brain_profiles.sql"];
    const { d, calls } = deps({ link: LINK, status: [{ ledger: "absent", pending: all, drift: [], unverified: [], unexpected: [], file_problems: [] }, { ledger: "present", pending: ["200_brain_profiles.sql"], drift: [], unverified: [], unexpected: [], file_problems: [] }] });
    const r = await runStaging(opts("--execute", "--backup-ref", "new project, nothing to back up", "--backfill-through", "none"), d);
    expect(r.ok, formatStaging(r)).toBe(true);
    const seq = calls.filter((c) => c.cmd === "psql" || c.args.some((a) => a.endsWith("migrations.ts"))).map((c) => (c.cmd === "psql" ? `psql ${c.args.at(-1)!.split("/").pop()}` : c.args.slice(1).join(" ")));
    expect(seq).toEqual(["status --json", "psql 100_engine_core.sql", "psql 101_engine_channels.sql", "psql 111_engine_ops.sql", "psql 117_engine_ops.sql", "backfill --through 117_engine_ops.sql --confirm", "status --json", "verify"]);
    expect(r.steps.find((s) => s.id === "migrations")!.detail).toMatch(/brain files not applied here: 200_brain_profiles\.sql/);
  });

  it("a ledger with no backfill point is never guessed", async () => {
    const { d, calls } = deps({ link: LINK, status: [{ ledger: "absent", pending: [], drift: [], unverified: [], unexpected: [], file_problems: [] }] });
    const r = await runStaging(opts("--execute", "--backup-ref", "pitr"), d);
    expect(r.steps.find((s) => s.id === "migrations")).toMatchObject({ result: "failed", detail: expect.stringMatching(/--backfill-through/) });
    expect(runs(calls, /^psql/)).toEqual([]);
  });

  it("drift or a database ahead of the checkout stops for a human; nothing is applied", async () => {
    const { d, calls } = deps({ link: LINK, status: [{ ledger: "present", pending: ["116_engine_analytics.sql"], drift: ["105_engine_security.sql"], unverified: [], unexpected: ["199_engine_future.sql"], file_problems: [] }] });
    const r = await runStaging(opts("--execute", "--backup-ref", "pitr"), d);
    expect(r.steps.find((s) => s.id === "migrations")).toMatchObject({ result: "failed", detail: expect.stringMatching(/needs a human: drift 105_engine_security\.sql, unexpected 199_engine_future\.sql/) });
    expect(runs(calls, /^psql/)).toEqual([]);
  });

  it("a failing migration stops the release and its error output is scrubbed of the database URL", async () => {
    const { d, calls } = deps({ link: LINK, fail: /psql .*103_engine_parity/, status: [{ ledger: "present", pending: ["103_engine_parity.sql", "104_engine_read_indexes.sql"], drift: [], unverified: [], unexpected: [], file_problems: [] }] });
    const r = await runStaging(opts("--execute", "--backup-ref", "pitr"), d);
    expect(r.ok).toBe(false);
    expect(r.steps.find((s) => s.id === "migrations")!.detail).toMatch(/applying 103_engine_parity\.sql failed \(rolled back, nothing recorded\): ERROR: boom at \[database url\]/);
    expect(runs(calls, /104_engine/)).toEqual([]);
    expect(runs(calls, /launch-gate/)).toEqual([]);
    expect(formatStaging(r)).not.toMatch(SECRETS);
  });

  it("a failing launch gate stops before deploy and smoke", async () => {
    const { d, calls } = deps({ link: LINK, fail: /launch-gate/ });
    const r = await runStaging(parseStagingArgs(["--env-file", "/secure/staging.env", "--execute", "--deploy", "--backup-ref", "pitr", "--server-id", "srv_staging1", "--rollback-ref", "dep_prev1", "--base-url", "https://haggle-staging.run.mcp-use.com"]), d);
    expect(r.steps.find((s) => s.id === "launch-gate")).toMatchObject({ result: "failed" });
    expect([...cli(calls), ...runs(calls, /smoke\.ts/)]).toEqual([]);
  });

  it("--deploy: build label, deploy, wait for the new build, then smoke with --expect-build", async () => {
    const { d, calls } = deps({ link: LINK, ready: ["oldbuild", "oldbuild", "ce4760e12345"] });
    const r = await runStaging(parseStagingArgs(["--env-file", "/secure/staging.env", "--execute", "--deploy", "--backup-ref", "pitr", "--server-id", "srv_staging1", "--rollback-ref", "dep_prev1", "--base-url", "https://haggle-staging.run.mcp-use.com"]), d);
    expect(r.ok, formatStaging(r)).toBe(true);
    expect(cli(calls).map((c) => c.args.join(" "))).toEqual(["servers env set srv_staging1 HAGGLE_BUILD_SHA=ce4760e12345", "servers env set srv_staging1 HAGGLE_BUILD_TIME=2026-10-22T18:00:00Z", "deploy --json"]);
    expect(cli(calls).every((c) => c.env.SUPABASE_DB_URL === undefined && c.env.INKBOX_API_KEY === undefined)).toBe(true);
    expect(runs(calls, /smoke\.ts/)[0]!.args.slice(1)).toEqual(["https://haggle-staging.run.mcp-use.com", "--live-readonly", "--expect-build", "ce4760e12345"]);
  });
});

describe("staging-release: helpers and the real CLI", () => {
  it("pgEnv and scrub", () => {
    expect(pgEnv("postgresql://u%40x:p%23w@h.example:6543/db?sslmode=require")).toEqual({ PGHOST: "h.example", PGPORT: "6543", PGUSER: "u@x", PGPASSWORD: "p#w", PGDATABASE: "db", PGSSLMODE: "require" });
    expect(scrub(`could not connect to ${STAGING_DB} as postgres.stagingref9 with st4gingPassw0rdXYZ`, ["st4gingPassw0rdXYZ", "postgres.stagingref9"])).toBe("could not connect to [database url] as [redacted] with [redacted]");
  });

  it("loads under plain node and prints usage without arguments", () => {
    const r = spawnSync(process.execPath, ["apps/mcp/scripts/staging-release.ts"], { cwd: ROOT, env: { PATH: process.env.PATH ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).not.toMatch(/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError|ERR_MODULE_NOT_FOUND/);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/usage: staging-release\.ts/);
  });

  it("plan mode for real: a production env file is refused, nothing printed but names", () => {
    const dir = mkdtempSync(join(tmpdir(), "haggle-staging-"));
    writeFileSync(join(dir, "prod.env"), ENV_FILE({ HAGGLE_ENV: "production", SUPABASE_DB_URL: PROD_DB }));
    const r = spawnSync(process.execPath, ["apps/mcp/scripts/staging-release.ts", "--env-file", join(dir, "prod.env")], { cwd: ROOT, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/REFUSED  environment: HAGGLE_ENV in the env file must be staging/);
    expect(r.stdout).toMatch(/REFUSED  database: SUPABASE_DB_URL points at a production database/);
    expect(r.stdout + r.stderr).not.toMatch(SECRETS);
  });
});
