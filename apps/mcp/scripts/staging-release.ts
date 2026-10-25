// Staging release, reproducibly: one command that refuses anything but staging, makes (or confirms) a
// backup, brings the staging database's migrations and ledger up to this checkout, runs the launch
// gate, prints (or, with --deploy, runs) the Manufact deploy, and smoke-tests the result read-only.
// docs/staging.md is the walkthrough. Prints variable names, file names and counts, never a value.
//
//   node apps/mcp/scripts/staging-release.ts --env-file <staging env file> [options]
//     (no --execute)           PLAN: check the target offline and print every step with its exact
//                              command. Connects to nothing, changes nothing.
//     --execute                run the steps: target checks, backup, migrations + ledger, launch gate,
//                              then smoke --live-readonly against what is deployed (--base-url)
//     --deploy                 with --execute: also set the build label and run `mcp-use deploy`, then
//                              wait for the new build and smoke it (needs --server-id, --rollback-ref)
//     --backup-dump <file>     pg_dump -Fc of the staging database to <file> (outside the repo) first
//     --backup-ref <text>      or: your own backup / PITR reference (you assert it exists)
//     --backfill-through <f>   only when the database has no ledger: the last migration you KNOW is
//                              applied (the live-database audit says 102_engine_stripe.sql), or none for a
//                              new, empty database (every engine file is applied in order)
//     --base-url https://<staging server>   smoke target; also checks webhook subscriptions (read-only)
//     --server-id <id>         the Manufact staging server id; must match .mcp-use/cloud/link.json
//     --rollback-ref <id>      the deployment id currently live on staging (mcp-use servers get <id>)
//     --production-server <id|slug>   never a deploy target (repeatable; calm-spark-ck3qm always is)
//     --checkout <dir>         the clean checkout of the commit to release (default: this repository)
//     --json
//
// Refuses (exit 1) when: the env file isn't HAGGLE_ENV=staging + HAGGLE_MODE=live; HAGGLE_PROD_DB_HOSTS
// is empty; HAGGLE_ALLOW_PROD_DB=true; SUPABASE_DB_URL looks like a production database (no override);
// payments aren't manual; the Manufact link is a production server or not --server-id; the checkout
// has uncommitted changes. Child commands get ONLY the env file's variables (plus PATH and HOME), so a
// production URL in the operator's shell can't leak in; psql / pg_dump get the database through PG*
// variables, never on their command line.
import "./dbGuard.ts"; // refuses a production SUPABASE_DB_URL in this process's own environment
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isEngineMigration } from "@haggle/engine";
import { looksLikeProductionDb, prodDbGuard, prodDbHosts } from "../src/config.ts";
import { parseEnvFile } from "./launch-gate.ts";

type Env = Record<string, string | undefined>;
/** The production Manufact server (docs/deployment.md §5). Always refused as a staging deploy target. */
export const KNOWN_PRODUCTION_SERVERS = ["calm-spark-ck3qm"];

export interface StagingOptions {
  envFile: string;
  execute: boolean;
  deploy: boolean;
  backupDump?: string;
  backupRef?: string;
  backfillThrough?: string;
  baseUrl?: string;
  serverId?: string;
  rollbackRef?: string;
  productionServers: string[];
  checkout?: string;
  json: boolean;
}

const USAGE = "usage: staging-release.ts --env-file <staging env file> [--execute [--deploy --server-id <id> --rollback-ref <deployment id>]] [--backup-dump <file> | --backup-ref <text>] [--backfill-through <NNN_file.sql>] [--base-url https://<staging server>] [--production-server <id|slug>]... [--checkout <dir>] [--json]";
const MIGRATION = /^\d{3}_[a-z0-9_]+\.sql$/;

export function parseStagingArgs(argv: string[]): StagingOptions {
  const val = (n: string) => { const i = argv.indexOf(`--${n}`); if (i < 0) return undefined; const v = argv[i + 1]; if (!v || v.startsWith("--")) throw new Error(`--${n} needs a value\n${USAGE}`); return v; };
  const envFile = val("env-file");
  if (!envFile) throw new Error(USAGE);
  const o: StagingOptions = { envFile, execute: argv.includes("--execute"), deploy: argv.includes("--deploy"), productionServers: [...KNOWN_PRODUCTION_SERVERS], json: argv.includes("--json") };
  argv.forEach((a, i) => { if (a === "--production-server" && argv[i + 1]) o.productionServers.push(argv[i + 1]!); });
  for (const [k, n] of [["backupDump", "backup-dump"], ["backupRef", "backup-ref"], ["backfillThrough", "backfill-through"], ["baseUrl", "base-url"], ["serverId", "server-id"], ["rollbackRef", "rollback-ref"], ["checkout", "checkout"]] as const) {
    const v = val(n);
    if (v !== undefined) o[k] = v;
  }
  if (o.deploy && !o.execute) throw new Error("--deploy runs only with --execute (without --execute nothing is run)");
  if (o.backupDump && o.backupRef) throw new Error("give --backup-dump or --backup-ref, not both");
  if (o.backfillThrough && o.backfillThrough !== "none" && !MIGRATION.test(o.backfillThrough)) throw new Error("--backfill-through needs a migration file name, e.g. 102_engine_stripe.sql, or none for a new, empty database");
  if (o.baseUrl && !/^https:\/\/[a-z0-9.-]+(?::\d+)?\/?$/i.test(o.baseUrl)) throw new Error("--base-url must be https://<host> (no path)");
  if (o.baseUrl) o.baseUrl = o.baseUrl.replace(/\/+$/, "");
  if (o.serverId && !/^[A-Za-z0-9_-]{3,80}$/.test(o.serverId)) throw new Error("--server-id must be a Manufact server id");
  if (o.rollbackRef && !/^[A-Za-z0-9_-]{3,80}$/.test(o.rollbackRef)) throw new Error("--rollback-ref must be a deployment id");
  if (o.deploy && (!o.serverId || !o.rollbackRef || !o.baseUrl)) throw new Error("--deploy needs --server-id, --rollback-ref (the deployment to roll back to) and --base-url");
  return o;
}

export interface Link { serverId?: string; serverSlug?: string }
export interface Problem { check: string; detail: string }

const truthy = (v?: string) => v?.trim().toLowerCase() === "true";
const host = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

/** Every reason this is not a safe staging target (pure). Empty = staging. */
export function targetProblems(o: StagingOptions, env: Env, link: Link | null, git: { sha: string | null; dirty: boolean }, repoRoot: string): Problem[] {
  const p: Problem[] = [];
  const add = (check: string, detail: string) => p.push({ check, detail });
  if ((env.HAGGLE_ENV ?? "").trim().toLowerCase() !== "staging") add("environment", "HAGGLE_ENV in the env file must be staging (this script never releases anything else)");
  if ((env.HAGGLE_MODE ?? "").trim() !== "live") add("environment", "HAGGLE_MODE in the env file must be live");
  if (truthy(env.HAGGLE_ALLOW_PROD_DB)) add("database", "HAGGLE_ALLOW_PROD_DB=true is refused in a staging env file");
  const hosts = prodDbHosts(env);
  if (!hosts.length) add("database", "HAGGLE_PROD_DB_HOSTS must list the production project ref, so staging can recognize and refuse it");
  const url = env.SUPABASE_DB_URL?.trim();
  if (!url) add("database", "SUPABASE_DB_URL is not set in the env file");
  else if (!/^postgres(?:ql)?:\/\//.test(url) || !host(url)) add("database", "SUPABASE_DB_URL is not a postgres:// connection string");
  else if (looksLikeProductionDb(url, hosts)) add("database", "SUPABASE_DB_URL points at a production database (HAGGLE_PROD_DB_HOSTS or a prod marker); there is no override here");
  else for (const e of prodDbGuard({ ...env, HAGGLE_ENV: "staging", HAGGLE_ALLOW_PROD_DB: undefined }, ["SUPABASE_DB_URL"])) add("database", e);
  if ((env.HAGGLE_PAYMENTS ?? "").trim() !== "manual") add("payments", "HAGGLE_PAYMENTS must be manual on staging (the pilot never moves money through Haggle)");
  const prod = o.productionServers.map((s) => s.toLowerCase());
  if (!link) add("manufact", ".mcp-use/cloud/link.json is missing in the checkout: link it to the STAGING server (docs/staging.md)");
  else {
    if ([link.serverId, link.serverSlug].some((s) => s && prod.includes(s.toLowerCase()))) add("manufact", "the checkout is linked to a production Manufact server; link a separate checkout to the staging server");
    if (o.serverId && link.serverId !== o.serverId) add("manufact", "the checkout's Manufact link is not --server-id");
  }
  if (o.baseUrl && prod.some((s) => host(o.baseUrl!).includes(s))) add("manufact", "--base-url is a production server");
  if (o.backupDump) {
    const abs = resolve(o.backupDump);
    const rel = relative(repoRoot, abs);
    if (!rel.startsWith("..") && !isAbsolute(rel)) add("backup", "--backup-dump must be outside the repository (a dump holds production-like data and must never be committed)");
  }
  if (!git.sha) add("checkout", "not a git checkout (release a clean checkout of the exact commit)");
  else if (git.dirty) add("checkout", "the checkout has uncommitted changes: release a clean checkout of the exact commit");
  return p;
}

export interface Step { id: string; title: string; who: "script" | "user"; commands: string[]; runs: boolean; note?: string }

/** The release as numbered steps with their exact commands (pure). `runs` = this invocation runs it. */
export function planSteps(o: StagingOptions, sha: string, buildTime: string): Step[] {
  const ef = o.envFile;
  const ledger = (args: string) => `node apps/mcp/scripts/migrations.ts ${args}`;
  const steps: Step[] = [
    { id: "target", title: "Refuse anything but staging (env file, database, Manufact link, checkout)", who: "script", commands: [], runs: true },
    o.backupDump
      ? { id: "backup", title: "Back up the staging database before any DDL", who: "script", commands: [`pg_dump --format=custom --no-owner --no-privileges --schema=public --file ${o.backupDump}   # SUPABASE_DB_URL via PG* variables; HAGGLE_DB_SCHEMA if set`], runs: o.execute }
      : { id: "backup", title: "Back up the staging database before any DDL", who: "user", commands: o.backupRef ? [] : ["(pass --backup-dump <file outside the repo> or --backup-ref <your backup / PITR reference>)"], runs: false, ...(o.backupRef ? { note: "operator reference recorded" } : { note: "BLOCKED until a backup is given" }) },
    { id: "migrations", title: "Apply this checkout's pending engine migrations, each in one transaction, and record them in the ledger", who: "script", runs: o.execute, commands: [
      ledger("status --json"),
      `psql -v ON_ERROR_STOP=1 -1 -f supabase/migrations/111_engine_ops.sql   # only if the ledger is absent`,
      ...(o.backfillThrough === "none" ? ["(new database: every engine file in order with psql -1 -f, then migrations.ts backfill --through <last engine file> --confirm)"]
        : o.backfillThrough ? [ledger(`backfill --through ${o.backfillThrough} --confirm`), ledger("record 111_engine_ops.sql --confirm")] : ["(ledger absent: pass --backfill-through <last applied file> or none; the script never guesses)"]),
      `for each pending 1NN_engine_*.sql: psql -v ON_ERROR_STOP=1 -1 -f supabase/migrations/<file> && ${ledger("record <file> --confirm")}`,
      ledger("verify"),
    ], note: "2xx brain migrations are Aarnav's: listed, never applied here" },
    { id: "launch-gate", title: "Launch gate for staging", who: "script", runs: o.execute, commands: [`node apps/mcp/scripts/launch-gate.ts --target staging --env-file ${ef} --db-url-env SUPABASE_DB_URL${o.baseUrl ? ` --check-webhooks --webhook-url ${o.baseUrl}/webhooks/inkbox` : ""}`] },
    { id: "deploy", title: "Deploy the release candidate to the Manufact staging server", who: o.deploy ? "script" : "user", runs: o.deploy, commands: [
      `./node_modules/.bin/mcp-use servers get ${o.serverId ?? "<staging server id>"} --json   # note the live deployment id first (--rollback-ref)`,
      `./node_modules/.bin/mcp-use servers env set ${o.serverId ?? "<staging server id>"} HAGGLE_BUILD_SHA=${sha}`,
      `./node_modules/.bin/mcp-use servers env set ${o.serverId ?? "<staging server id>"} HAGGLE_BUILD_TIME=${buildTime}`,
      "./node_modules/.bin/mcp-use deploy --json",
    ], ...(o.deploy ? {} : { note: "printed only: rerun with --execute --deploy --server-id <id> --rollback-ref <deployment id> --base-url <url>, or run these yourself" }) },
    { id: "smoke", title: "Smoke the deployed server read-only (never sends, calls, texts or pays)", who: "script", runs: o.execute && !!o.baseUrl, commands: [`HAGGLE_SMOKE_TOKEN=<staging workspace bearer> node apps/mcp/scripts/smoke.ts ${o.baseUrl ?? "https://<staging server>"} --live-readonly${o.deploy ? ` --expect-build ${sha}` : ""}`], ...(o.baseUrl ? {} : { note: "needs --base-url" }) },
    { id: "rollback", title: "If anything after the deploy fails: roll back", who: "user", runs: false, commands: [`redeploy the previous commit (deployment ${o.rollbackRef ?? "<id noted before the deploy>"}) with the same steps; the schema stays (additive), launch-gate/verify then need --allow-ahead; a schema restore uses the backup (docs/backup-restore.md)`] },
  ];
  return steps;
}

export interface RunResult { status: number | null; stdout: string; stderr: string }
export interface StagingDeps {
  readFile: (path: string) => string;
  exists: (path: string) => boolean;
  /** Runs a command with exactly `env` (never the caller's environment). */
  run: (cmd: string, args: string[], opts: { env: Env; cwd: string }) => RunResult;
  fetchJson?: (url: string) => Promise<Record<string, unknown> | null>;
  sleep?: (ms: number) => Promise<void>;
  now: () => Date;
  repoRoot: string;
  out: (line: string) => void;
}

/** postgres:// URL -> libpq variables, so no command line carries the password. */
export function pgEnv(url: string): Env {
  const u = new URL(url);
  const ssl = u.searchParams.get("sslmode");
  return { PGHOST: u.hostname, PGPORT: u.port || "5432", PGUSER: decodeURIComponent(u.username), PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres", ...(ssl ? { PGSSLMODE: ssl } : {}) };
}

/** Removes any piece of the database URL (or the token) from a child's output before it is shown. */
export function scrub(text: string, secrets: (string | undefined)[]): string {
  let t = text.replace(/postgres(?:ql)?:\/\/\S+/g, "[database url]");
  for (const s of secrets.filter((x): x is string => !!x && x.length >= 4).sort((a, b) => b.length - a.length)) t = t.split(s).join("[redacted]");
  return t;
}

export interface StagingResult { ok: boolean; mode: "plan" | "execute"; sha: string | null; problems: Problem[]; steps: (Step & { result?: "ok" | "failed" | "skipped" | "blocked"; detail?: string })[] }

export async function runStaging(o: StagingOptions, d: StagingDeps): Promise<StagingResult> {
  const checkout = resolve(o.checkout ?? d.repoRoot);
  let env: Env;
  try { env = parseEnvFile(d.readFile(o.envFile)); } catch { return { ok: false, mode: o.execute ? "execute" : "plan", sha: null, problems: [{ check: "environment", detail: "cannot read the env file" }], steps: [] }; }
  const base: Env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
  // Least privilege per child: the ledger CLI gets the database, the gate reads the env file itself,
  // smoke gets the workspace token only. Never the caller's shell environment.
  const pick = (...keys: string[]): Env => Object.fromEntries(keys.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
  const ledgerEnv: Env = { ...base, ...pick("SUPABASE_DB_URL", "HAGGLE_ENV", "HAGGLE_PROD_DB_HOSTS", "HAGGLE_DB_SCHEMA") };
  const git = (args: string[]) => d.run("git", ["-C", checkout, ...args], { env: base, cwd: checkout });
  const head = git(["rev-parse", "--short=12", "HEAD"]);
  const sha = head.status === 0 ? head.stdout.trim() : null;
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim().length > 0;
  let link: Link | null = null;
  const linkPath = join(checkout, ".mcp-use", "cloud", "link.json");
  if (d.exists(linkPath)) { try { const j = JSON.parse(d.readFile(linkPath)) as Link; link = { ...(j.serverId ? { serverId: String(j.serverId) } : {}), ...(j.serverSlug ? { serverSlug: String(j.serverSlug) } : {}) }; } catch { link = null; } }
  const problems = targetProblems(o, env, link, { sha, dirty }, d.repoRoot);
  const steps: StagingResult["steps"] = planSteps(o, sha ?? "<sha>", d.now().toISOString().replace(/\.\d{3}Z$/, "Z"));
  const secrets = [env.SUPABASE_DB_URL, env.HAGGLE_SMOKE_TOKEN, ...(env.SUPABASE_DB_URL ? Object.values(pgEnv(env.SUPABASE_DB_URL)).filter((v) => v && v.length >= 8) : [])];
  const mark = (id: string, result: "ok" | "failed" | "skipped" | "blocked", detail?: string) => { const s = steps.find((x) => x.id === id)!; s.result = result; if (detail) s.detail = scrub(detail, secrets); };
  mark("target", problems.length ? "failed" : "ok", problems.length ? `${problems.length} problem(s)` : `staging; commit ${sha}`);
  const done = (ok: boolean): StagingResult => ({ ok, mode: o.execute ? "execute" : "plan", sha, problems, steps });
  const backupMissing = !o.backupDump && !o.backupRef;
  if (problems.length) return done(false);
  if (!o.execute) {
    if (backupMissing) mark("backup", "blocked", "no backup given: --execute will refuse until --backup-dump or --backup-ref");
    return done(true);
  }

  // ---- execute ----
  const node = (script: string, args: string[], childEnv: Env = ledgerEnv) => d.run(process.execPath, [join(checkout, "apps", "mcp", "scripts", script), ...args], { env: childEnv, cwd: checkout });
  const fail = (id: string, detail: string) => { mark(id, "failed", detail); return done(false); };

  if (backupMissing) { mark("backup", "blocked", "refused: give --backup-dump <file> or --backup-ref <reference> before any DDL"); return done(false); }
  if (o.backupDump) {
    const r = d.run("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--schema=${env.HAGGLE_DB_SCHEMA?.trim() || "public"}`, "--file", resolve(o.backupDump)], { env: { ...base, ...pgEnv(env.SUPABASE_DB_URL!) }, cwd: checkout });
    if (r.status !== 0) return fail("backup", `pg_dump exited ${r.status}: ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    mark("backup", "ok", `dump written to ${o.backupDump}`);
  } else mark("backup", "ok", `operator reference: ${o.backupRef!.slice(0, 80)}`);

  // Migrations: what the ledger says, then each pending engine file (+ its ledger row), then verify.
  const statusOf = () => { const r = node("migrations.ts", ["status", "--json"]); try { return r.status === 0 ? JSON.parse(r.stdout) as { ledger: string; pending: string[]; drift: string[]; unverified: string[]; unexpected: string[]; file_problems: string[] } : null; } catch { return null; } };
  let s = statusOf();
  if (!s) return fail("migrations", "migrations.ts status failed (database unreachable or refused)");
  if (s.file_problems.length) return fail("migrations", `migration files: ${s.file_problems.join("; ")}`);
  const psql = (file: string) => d.run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-1", "-f", join(checkout, "supabase", "migrations", file)], { env: { ...base, ...pgEnv(env.SUPABASE_DB_URL!) }, cwd: checkout });
  const applied: string[] = [];
  if (s.ledger === "absent" && o.backfillThrough === "none") {
    // A new, empty staging database: every engine file in order (the ledger appears with 111), then
    // record them all at once.
    const all = s.pending.filter(isEngineMigration);
    for (const f of all) {
      const r = psql(f);
      if (r.status !== 0) return fail("migrations", `applying ${f} failed (rolled back): ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
      applied.push(f);
    }
    const last = all.at(-1);
    const x = last ? node("migrations.ts", ["backfill", "--through", last, "--confirm"]) : { status: 0, stdout: "" };
    if (x.status !== 0) return fail("migrations", `migrations.ts backfill failed: ${x.stdout.trim().split("\n").slice(-1)[0] ?? ""}`);
    s = statusOf();
    if (!s) return fail("migrations", "migrations.ts status failed after the first apply");
  } else if (s.ledger === "absent") {
    if (!o.backfillThrough) return fail("migrations", "the database has no ledger: pass --backfill-through <the last migration you know is applied> (the live-database audit: 102_engine_stripe.sql), or none for a new, empty database");
    const r = psql("111_engine_ops.sql");
    if (r.status !== 0) return fail("migrations", `applying 111_engine_ops.sql failed: ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    for (const args of [["backfill", "--through", o.backfillThrough, "--confirm"], ["record", "111_engine_ops.sql", "--confirm"]]) {
      const x = node("migrations.ts", args);
      if (x.status !== 0) return fail("migrations", `migrations.ts ${args[0]} failed: ${x.stdout.trim().split("\n").slice(-1)[0] ?? ""}`);
    }
    applied.push("111_engine_ops.sql");
    s = statusOf();
    if (!s) return fail("migrations", "migrations.ts status failed after creating the ledger");
  }
  const blocking = [...s.drift.map((n) => `drift ${n}`), ...s.unverified.filter(isEngineMigration).map((n) => `unverified ${n}`), ...s.unexpected.map((n) => `unexpected ${n}`)];
  if (blocking.length) return fail("migrations", `needs a human: ${blocking.join(", ")} (docs/deployment.md §4; never --accept-drift without comparing)`);
  for (const f of s.pending.filter(isEngineMigration)) {
    const r = psql(f);
    if (r.status !== 0) return fail("migrations", `applying ${f} failed (rolled back, nothing recorded): ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    const rec = node("migrations.ts", ["record", f, "--confirm"]);
    if (rec.status !== 0) return fail("migrations", `${f} applied but recording it failed: run migrations.ts record ${f} --confirm`);
    applied.push(f);
  }
  const v = node("migrations.ts", ["verify"]);
  if (v.status !== 0) return fail("migrations", "migrations.ts verify failed after applying");
  const brain = s.pending.filter((n) => !isEngineMigration(n));
  mark("migrations", "ok", `${applied.length ? `applied ${applied.join(", ")}` : "nothing pending"}; ledger verified${brain.length ? `; brain files not applied here: ${brain.join(", ")}` : ""}`);

  const gateArgs = ["--target", "staging", "--env-file", resolve(o.envFile), "--db-url-env", "SUPABASE_DB_URL", ...(o.baseUrl ? ["--check-webhooks", "--webhook-url", `${o.baseUrl}/webhooks/inkbox`] : [])];
  const g = node("launch-gate.ts", gateArgs, base);
  if (g.status !== 0) return fail("launch-gate", g.stdout.trim().split("\n").filter((l) => l.startsWith("FAIL")).join(" | ") || `exit ${g.status}`);
  mark("launch-gate", "ok", g.stdout.trim().split("\n").slice(-1)[0]);

  if (o.deploy) {
    const cli = join(checkout, "node_modules", ".bin", "mcp-use");
    for (const kv of [`HAGGLE_BUILD_SHA=${sha}`, `HAGGLE_BUILD_TIME=${d.now().toISOString().replace(/\.\d{3}Z$/, "Z")}`]) {
      const r = d.run(cli, ["servers", "env", "set", o.serverId!, kv], { env: base, cwd: checkout });
      if (r.status !== 0) return fail("deploy", `mcp-use servers env set exited ${r.status}`);
    }
    const r = d.run(cli, ["deploy", "--json"], { env: base, cwd: checkout });
    if (r.status !== 0) return fail("deploy", `mcp-use deploy exited ${r.status}; roll back to ${o.rollbackRef} if the server changed`);
    mark("deploy", "ok", `deployed ${sha}; rollback target ${o.rollbackRef}`);
    // Wait (up to 10 min) until the server reports the new build.
    if (d.fetchJson) {
      let seen = false;
      for (let i = 0; i < 60 && !seen; i++) {
        const j = await d.fetchJson(`${o.baseUrl}/ready`).catch(() => null);
        seen = j?.build_sha === sha;
        if (!seen) await (d.sleep ?? ((ms) => new Promise((res) => setTimeout(res, ms))))(10_000);
      }
      if (!seen) return fail("smoke", `the server did not report build ${sha} within 10 minutes`);
    }
  } else mark("deploy", "skipped", "printed only (no --deploy)");

  if (!o.baseUrl) { mark("smoke", "skipped", "no --base-url"); return done(true); }
  const token = env.HAGGLE_SMOKE_TOKEN?.trim();
  if (!token) return fail("smoke", "HAGGLE_SMOKE_TOKEN (a staging workspace bearer) is not in the env file");
  const sm = node("smoke.ts", [o.baseUrl, "--live-readonly", ...(o.deploy ? ["--expect-build", sha!] : [])], { ...base, HAGGLE_SMOKE_TOKEN: token });
  if (sm.status !== 0) return fail("smoke", sm.stdout.trim().split("\n").filter((l) => l.startsWith("FAIL")).join(" | ") || `exit ${sm.status}`);
  mark("smoke", "ok", "smoke --live-readonly passed");
  return done(true);
}

export function formatStaging(r: StagingResult): string {
  const lines = [`staging release ${r.mode === "plan" ? "PLAN (nothing is run)" : "EXECUTE"}: commit ${r.sha ?? "?"}`];
  for (const p of r.problems) lines.push(`REFUSED  ${p.check}: ${p.detail}`);
  r.steps.forEach((s, i) => {
    lines.push(`${i + 1}. [${s.who === "user" ? "YOU" : "script"}] ${s.title}${s.result ? ` - ${s.result.toUpperCase()}${s.detail ? `: ${s.detail}` : ""}` : s.runs ? "" : " - not run in this mode"}`);
    for (const c of s.commands) lines.push(`     $ ${c}`);
    if (s.note) lines.push(`     (${s.note})`);
  });
  lines.push(`staging release: ${r.ok ? "OK" : "STOPPED"}`);
  return lines.join("\n");
}

/** The real dependencies (never used by the unit tests). */
export function realDeps(repoRoot: string): StagingDeps {
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    exists: existsSync,
    run: (cmd, args, opts) => { const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 }); return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error.message) : "") }; },
    fetchJson: async (url) => { const res = await fetch(url, { signal: AbortSignal.timeout(15_000) }); try { return await res.json() as Record<string, unknown>; } catch { return null; } },
    now: () => new Date(),
    repoRoot,
    out: (l) => console.log(l),
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/staging-release.ts")) {
  let opts: StagingOptions;
  try { opts = parseStagingArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message); process.exit(2); }
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  runStaging(opts, realDeps(root)).then((r) => {
    console.log(opts.json ? JSON.stringify(r) : formatStaging(r));
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => {
    console.error(`staging release failed: ${scrub((e as Error).message, [])}`);
    process.exit(1);
  });
}
