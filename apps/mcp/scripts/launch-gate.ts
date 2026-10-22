// Launch gate: every objectively checkable deployment prerequisite for one target, in one run.
// Exit 0 = nothing failed (warnings allowed), 1 = something failed, 2 = usage error. Prints names,
// counts and file names only, never a value, a URL or a key.
//
//   npx tsx apps/mcp/scripts/launch-gate.ts --target staging|production|development
//       [--env-file <the target's env file>]   config validated from THIS file only (never .env by default)
//       [--db-url-env SUPABASE_DB_URL]         read the migration ledger (read-only) from the database this
//                                              variable names (looked up in the env file, then the shell)
//       [--allow-ahead]                        a database with engine migrations this checkout lacks is OK (rollback)
//       [--check-webhooks --webhook-url https://<server>/webhooks/inkbox]
//                                              read-only: the buyer identity's Inkbox subscriptions (needs
//                                              INKBOX_API_KEY in the env file); off unless both are given
//       [--skip-config] [--skip-build] [--json]
//
// Checks: config (src/config.ts checkConfig for the file, which must say HAGGLE_ENV=<target>);
// recommended variables (warnings); migration files (duplicate numbers, names); migration ledger vs
// this checkout (pending, drift, unverified, unexpected); production-database guard for the ledger
// read; build present and newer than the sources; webhook subscription events. "Tests last green"
// is not checkable here: it is reported as skip (check CI on the commit).
import "./dbGuard.ts"; // refuses a production SUPABASE_DB_URL outside HAGGLE_ENV=production (src/config.ts)
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compareMigrations, findMigrationsDir, isEngineMigration, ledgerClient, migrationFileProblems, readLedger, repoMigrations, type LedgerRow } from "@haggle/engine";
import { checkConfig, HAGGLE_ENVS, prodDbGuard, type HaggleEnv } from "../src/config.ts";
import { missingRecommended, targetOf } from "../src/envManifest.ts";

type Env = Record<string, string | undefined>;
export type Status = "pass" | "fail" | "warn" | "skip";
export interface GateCheck { name: string; status: Status; detail: string }
export interface GateResult { ok: boolean; target: HaggleEnv; checks: GateCheck[] }

export interface GateOptions {
  target: HaggleEnv;
  envFile?: string;
  dbUrlEnv?: string;
  allowAhead: boolean;
  checkWebhooks: boolean;
  webhookUrl?: string;
  skipConfig: boolean;
  skipBuild: boolean;
  json: boolean;
}

/** Events the server handles at /webhooks/inkbox (src/webhook.ts); message.received is the one email needs. */
export const WEBHOOK_EVENTS = ["message.received", "call.ended", "imessage.received", "a2a.sent_task.updated"] as const;

export interface GateDeps {
  readFile: (path: string) => string;
  processEnv: Env;
  migrationsDir: string | null;
  readLedger: (url: string, schema?: string) => Promise<LedgerRow[] | null>;
  /** Build output and the newest source mtime (ms); null = no build. */
  build: () => { builtAt: number; newestSource: number } | null;
  listWebhooks?: (apiKey: string, identity: string) => Promise<{ url: string; eventTypes: string[] }[]>;
}

const val = (argv: string[], n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };

export function parseGateArgs(argv: string[]): GateOptions {
  const target = val(argv, "target")?.toLowerCase();
  if (!target || !(HAGGLE_ENVS as readonly string[]).includes(target)) throw new Error("usage: launch-gate.ts --target development|staging|production [--env-file <file>] [--db-url-env NAME] [--allow-ahead] [--check-webhooks --webhook-url <url>] [--skip-config] [--skip-build] [--json]");
  const dbUrlEnv = val(argv, "db-url-env");
  if (dbUrlEnv !== undefined && !/^[A-Z][A-Z0-9_]{2,60}$/.test(dbUrlEnv)) throw new Error("--db-url-env must name an environment variable");
  const envFile = val(argv, "env-file");
  if (argv.includes("--env-file") && !envFile) throw new Error("--env-file needs a path");
  const webhookUrl = val(argv, "webhook-url");
  const checkWebhooks = argv.includes("--check-webhooks");
  if (checkWebhooks && !(webhookUrl && /^https:\/\/[^\s/]+\/.*webhooks\/inkbox$/.test(webhookUrl))) throw new Error("--check-webhooks needs --webhook-url https://<server>/webhooks/inkbox");
  return { target: target as HaggleEnv, ...(envFile ? { envFile } : {}), ...(dbUrlEnv ? { dbUrlEnv } : {}), allowAhead: argv.includes("--allow-ahead"), checkWebhooks, ...(webhookUrl ? { webhookUrl } : {}), skipConfig: argv.includes("--skip-config"), skipBuild: argv.includes("--skip-build"), json: argv.includes("--json") };
}

/** KEY=VALUE lines (optional `export`, quotes, comments). The values stay in memory; nothing is printed. */
export function parseEnvFile(text: string): Env {
  const env: Env = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    env[m[1]!] = v;
  }
  return env;
}

/** A database error reduced to its code / class: never its message (it may carry a host or user). */
const dbErrorClass = (e: unknown) => {
  const x = e as { code?: unknown; name?: unknown };
  return typeof x?.code === "string" && /^[A-Z0-9_]{2,40}$/.test(x.code) ? x.code : typeof x?.name === "string" ? x.name : "error";
};

export async function runLaunchGate(o: GateOptions, d: GateDeps): Promise<GateResult> {
  const checks: GateCheck[] = [];
  const add = (name: string, status: Status, detail: string) => checks.push({ name, status, detail });
  let fileEnv: Env | null = null;

  // 1. Configuration for the target, from the operator's file only.
  if (o.skipConfig) add("config", "skip", "--skip-config");
  else if (!o.envFile) add("config", "fail", "pass --env-file <the target's env file> (nothing reads .env by default), or --skip-config");
  else {
    try {
      fileEnv = parseEnvFile(d.readFile(o.envFile));
    } catch (e) {
      add("config", "fail", `cannot read the env file (${dbErrorClass(e)})`);
    }
    if (fileEnv) {
      const declared = fileEnv.HAGGLE_ENV?.trim().toLowerCase() || "development";
      const r = checkConfig(fileEnv);
      const problems = [...(declared !== o.target ? [`HAGGLE_ENV in the file is ${(HAGGLE_ENVS as readonly string[]).includes(declared) ? declared : "invalid"}, not ${o.target}`] : []), ...((o.target !== "development" && r.mode !== "live") ? [`HAGGLE_MODE must be live for ${o.target}`] : []), ...r.errors];
      add("config", problems.length ? "fail" : "pass", problems.length ? problems.join("; ") : `${o.target}, ${r.mode} mode`);
      for (const w of r.warnings) add("config warning", "warn", w);
      const rec = missingRecommended(fileEnv, targetOf({ ...fileEnv, HAGGLE_ENV: o.target }));
      add("recommended variables", rec.length ? "warn" : "pass", rec.length ? `not set: ${rec.join(", ")}` : "all set");
    }
  }

  // 2. Migration files and the ledger.
  if (!d.migrationsDir) add("migration files", "fail", "supabase/migrations not found (run from a checkout of the commit you deploy)");
  else {
    const fp = migrationFileProblems(d.migrationsDir);
    add("migration files", fp.length ? "fail" : "pass", fp.length ? fp.join("; ") : `${repoMigrations(d.migrationsDir).length} files, numbers unique`);
  }
  if (!o.dbUrlEnv) add("migrations", "skip", "no --db-url-env given (the ledger isn't read)");
  else if (d.migrationsDir) {
    const source: Env = { ...d.processEnv, ...(fileEnv ?? {}) };
    const url = source[o.dbUrlEnv]?.trim();
    // The guard as the target would apply it: a production database only for --target production.
    const refused = url ? prodDbGuard({ ...source, HAGGLE_ENV: o.target, HAGGLE_ALLOW_PROD_DB: source.HAGGLE_ALLOW_PROD_DB }, [o.dbUrlEnv]) : [];
    if (!url) add("migrations", "fail", `${o.dbUrlEnv} is not set (in the env file or the shell)`);
    else if (refused.length) add("migrations", "fail", refused.join("; "));
    else {
      try {
        const ledger = await d.readLedger(url, source.HAGGLE_DB_SCHEMA?.trim() || undefined);
        const s = compareMigrations(repoMigrations(d.migrationsDir), ledger, isEngineMigration, { allowUnexpected: o.allowAhead });
        const eng = (l: string[]) => l.filter(isEngineMigration);
        const parts = [
          s.ledger === "absent" ? "ledger absent (apply 111_engine_ops.sql, then backfill)" : `${s.applied.length} applied`,
          ...(eng(s.pending).length && s.ledger === "present" ? [`pending: ${eng(s.pending).join(", ")}`] : []),
          ...(eng(s.drift).length ? [`DRIFT: ${eng(s.drift).join(", ")}`] : []),
          ...(eng(s.unverified).length ? [`unverified: ${eng(s.unverified).join(", ")}`] : []),
          ...(s.unexpected.length ? [`${o.allowAhead ? "ahead (allowed)" : "UNEXPECTED (database ahead of this checkout; --allow-ahead for a rollback)"}: ${s.unexpected.join(", ")}`] : []),
        ];
        add("migrations", s.ok ? "pass" : "fail", parts.join("; "));
      } catch (e) {
        add("migrations", "fail", `ledger unreadable (${dbErrorClass(e)})`);
      }
    }
  }

  // 3. Build present and not older than the sources.
  if (o.skipBuild) add("build", "skip", "--skip-build");
  else {
    const b = d.build();
    if (!b) add("build", "fail", "apps/mcp/.mcp-use/build is missing: run npm run build");
    else add("build", b.builtAt >= b.newestSource ? "pass" : "fail", b.builtAt >= b.newestSource ? "present and newer than the sources" : "older than the sources: run npm run build");
  }

  // 4. Tests: not checkable from here.
  add("tests last green", "skip", "check CI on the exact commit (GitHub Actions: CI)");

  // 5. Webhook subscriptions (read-only, opt-in).
  if (!o.checkWebhooks) add("webhook subscriptions", "skip", "off (--check-webhooks --webhook-url to read them)");
  else if (!fileEnv?.INKBOX_API_KEY?.trim()) add("webhook subscriptions", "fail", "INKBOX_API_KEY is not in the env file");
  else if (!d.listWebhooks) add("webhook subscriptions", "fail", "no Inkbox client");
  else {
    try {
      const subs = (await d.listWebhooks(fileEnv.INKBOX_API_KEY.trim(), fileEnv.INKBOX_IDENTITY?.trim() || "haggle")).filter((s) => s.url === o.webhookUrl);
      const have = new Set(subs.flatMap((s) => s.eventTypes));
      const missing = WEBHOOK_EVENTS.filter((e) => !have.has(e));
      const host = new URL(o.webhookUrl!).host;
      if (!subs.length) add("webhook subscriptions", "fail", `no subscription points at ${host}/webhooks/inkbox`);
      else if (!have.has("message.received")) add("webhook subscriptions", "fail", `${host}: message.received is missing (email replies would only arrive by reconciliation)`);
      else add("webhook subscriptions", missing.length ? "warn" : "pass", missing.length ? `${host}: not subscribed to ${missing.join(", ")} (needed only for enabled channels)` : `${host}: ${WEBHOOK_EVENTS.length} events`);
    } catch (e) {
      add("webhook subscriptions", "fail", `could not list subscriptions (${dbErrorClass(e)})`);
    }
  }

  return { ok: checks.every((c) => c.status !== "fail"), target: o.target, checks };
}

export function formatGate(r: GateResult): string {
  return [...r.checks.map((c) => `${c.status.toUpperCase().padEnd(4)}  ${c.name}${c.detail ? ` - ${c.detail}` : ""}`), `launch gate (${r.target}): ${r.ok ? "OK" : "FAILED"}`].join("\n");
}

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    newest = Math.max(newest, e.isDirectory() ? newestMtime(p) : /\.(ts|tsx)$/.test(e.name) ? statSync(p).mtimeMs : 0);
  }
  return newest;
}

/** The real dependencies (never used by the unit tests). */
export function realDeps(root: string): GateDeps {
  const app = join(root, "apps", "mcp");
  return {
    readFile: (p) => readFileSync(p, "utf8"),
    processEnv: process.env,
    migrationsDir: findMigrationsDir(root),
    readLedger: async (url, schema) => {
      const sql = ledgerClient(url, schema);
      try { return await readLedger(sql); } finally { await sql.end({ timeout: 5 }); }
    },
    build: () => {
      const out = join(app, ".mcp-use", "build", "index.js");
      if (!existsSync(out) || !existsSync(join(app, ".mcp-use", "build", "manifest.json"))) return null;
      const newestSource = Math.max(statSync(join(app, "index.ts")).mtimeMs, newestMtime(join(app, "src")), newestMtime(join(app, "views")), newestMtime(join(root, "packages", "engine", "src")), newestMtime(join(root, "packages", "core")));
      return { builtAt: statSync(out).mtimeMs, newestSource };
    },
    listWebhooks: async (apiKey, identity) => {
      const { Inkbox } = await import("@inkbox/sdk");
      const inkbox = new Inkbox({ apiKey });
      const id = await inkbox.getIdentity(identity);
      return (await inkbox.webhooks.subscriptions.list({ agentIdentityId: id.id, scope: "identity" })).map((s) => ({ url: s.url, eventTypes: s.eventTypes }));
    },
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/launch-gate.ts")) {
  let opts: GateOptions;
  try {
    opts = parseGateArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  runLaunchGate(opts, realDeps(new URL("../../..", import.meta.url).pathname)).then((r) => {
    console.log(opts.json ? JSON.stringify(r) : formatGate(r));
    process.exit(r.ok ? 0 : 1);
  }).catch((e) => {
    console.error(`launch gate failed: ${dbErrorClass(e)}`);
    process.exit(1);
  });
}
