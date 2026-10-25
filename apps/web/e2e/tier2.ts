// Tier-2 browser test runner (local only; needs Docker Desktop running and `npm run build -w @haggle/mcp`):
//
//   node apps/web/e2e/tier2.ts            from the repo root
//   node apps/web/e2e/tier2.ts --keep     leave the local Supabase stack running afterwards
//
// 1. Starts a local Supabase stack (apps/web/e2e/supabase/config.toml: anonymous sign-ins on, ports
//    554xx) with the pinned CLI, and applies supabase/migrations/*.sql to its database once.
// 2. Starts the fake Claude (e2e/fakeAnthropic.ts), the built MCP server in mock mode (auth required,
//    service token, HAGGLE_MOCK_DATABASE_URL = the local database, so workspaces live where
//    workspace_members points), and the web app built with NEXT_PUBLIC_HAGGLE_DEMO=true against the
//    local stack. This rebuilds apps/web/.next: rebuild with placeholders before tier 1 again.
// 3. Runs e2e/guest-deal.spec.ts, then stops every process (and the stack, unless --keep).
//
// Keys and tokens are local throwaways, passed only through process environments, never printed or
// written to a file. Nothing here reaches Anthropic, Supabase cloud, Inkbox or Stripe.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeAnthropic } from "./fakeAnthropic.ts";

const SUPABASE_CLI = "supabase@2.122.0";
const WEB = join(import.meta.dirname, "..");
const ROOT = join(WEB, "../..");
const MCP = join(ROOT, "apps/mcp");
const WIN = process.platform === "win32";
const DB_CONTAINER = "supabase_db_haggle-web-e2e";
const keep = process.argv.includes("--keep");
const LOGS = join(tmpdir(), "haggle-tier2");
const children: ChildProcess[] = [];

const log = (m: string) => console.log(`[tier2] ${m}`);
// Windows runs commands through cmd (for .cmd shims): quote a path with spaces, leave bare names alone.
const shellCmd = (cmd: string) => (WIN && /[\s\\/]/.test(cmd) ? `"${cmd}"` : cmd);

function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; quiet?: boolean } = {}) {
  const r = spawnSync(shellCmd(cmd), args, { cwd: opts.cwd ?? ROOT, env: opts.env ?? process.env, input: opts.input, encoding: "utf8", shell: WIN, stdio: opts.quiet || opts.input !== undefined ? "pipe" : "inherit", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status})${opts.quiet ? `: ${(r.stderr || "").slice(-2000)}` : ""}`);
  return r.stdout ?? "";
}

function start(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, name: string): ChildProcess {
  // Each server writes straight to <os tmp>/haggle-tier2/<name>.log (Playwright wipes test-results/).
  mkdirSync(LOGS, { recursive: true });
  const file = join(LOGS, `${name}.log`);
  const fd = openSync(file, "w");
  const p = spawn(shellCmd(cmd), args, { cwd, env, stdio: ["ignore", fd, fd], shell: WIN });
  p.on("exit", (code) => { if (code && code !== 0) log(`${name} exited with ${code}; see ${file}`); });
  children.push(p);
  return p;
}

function stopAll() {
  for (const p of children) {
    if (!p.pid || p.exitCode !== null) continue;
    // Windows: the servers run under a shell, so kill the whole tree or they keep their ports.
    if (WIN) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill();
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer().once("error", reject).listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, what: string, ms = 90_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what} did not come up at ${url}`);
}

function bin(dir: string, name: string): string {
  const found = [join(dir, "node_modules/.bin", name), join(ROOT, "node_modules/.bin", name)].map((p) => (WIN ? `${p}.cmd` : p)).find((p) => existsSync(p));
  if (!found) throw new Error(`${name} isn't installed (npm ci)`);
  return found;
}

/** The local stack's URLs and keys (read from the CLI, kept in memory). */
function supabaseStatus(): { api: string; db: string; anon: string; service: string } {
  const out = run("npx", ["--yes", SUPABASE_CLI, "status", "--workdir", "apps/web/e2e", "-o", "json"], { quiet: true });
  const s = JSON.parse(out.slice(out.indexOf("{"))) as Record<string, string>;
  const api = s.API_URL, db = s.DB_URL, anon = s.ANON_KEY, service = s.SERVICE_ROLE_KEY;
  if (!api || !db || !anon || !service) throw new Error("supabase status didn't report API_URL, DB_URL, ANON_KEY and SERVICE_ROLE_KEY");
  return { api, db, anon, service };
}

function psql(sql: string, quiet = true): string {
  return run("docker", ["exec", "-i", DB_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-tA"], { input: sql, quiet });
}

function applyMigrations() {
  if (psql("select to_regclass('public.workspace_members') is not null;").trim() === "t") log("migrations already applied");
  else {
    const dir = join(ROOT, "supabase/migrations");
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      psql(readFileSync(join(dir, f), "utf8"));
      log(`applied ${f}`);
    }
  }
  // PostgREST caches the schema at start-up, before these tables existed.
  psql("notify pgrst, 'reload schema';");
}

async function main() {
  if (spawnSync("docker", ["version"], { stdio: "ignore", shell: WIN }).status !== 0) throw new Error("Docker isn't running: start Docker Desktop (tier 2 needs it)");
  if (!existsSync(join(MCP, ".mcp-use/build/index.js"))) throw new Error("the MCP server isn't built: npm run build -w @haggle/mcp");

  log("starting local Supabase (first run pulls images)");
  run("npx", ["--yes", SUPABASE_CLI, "start", "--workdir", "apps/web/e2e"], { quiet: true });
  const sb = supabaseStatus();
  applyMigrations();

  const fake = await startFakeAnthropic();
  const [mcpPort, webPort] = [await freePort(), await freePort()];
  const service = `svc-tier2-${randomBytes(24).toString("hex")}`;

  log(`starting the MCP server (mock) on ${mcpPort}`);
  start(bin(MCP, "mcp-use"), ["start"], MCP, {
    ...process.env, PORT: String(mcpPort), HAGGLE_MODE: "mock", HAGGLE_AUTH: "required", HAGGLE_SIM_DELAY_SCALE: "0",
    HAGGLE_SERVICE_TOKEN: service, HAGGLE_MOCK_DATABASE_URL: sb.db,
  }, "mcp");
  await waitFor(`http://127.0.0.1:${mcpPort}/health`, "the MCP server");

  const publicEnv = { NEXT_PUBLIC_HAGGLE_DEMO: "true", NEXT_PUBLIC_SUPABASE_URL: sb.api, NEXT_PUBLIC_SUPABASE_ANON_KEY: sb.anon, NEXT_PUBLIC_TURNSTILE_SITE_KEY: "" };
  if (process.argv.includes("--no-build")) log("--no-build: reusing apps/web/.next (must be a tier-2 build)");
  else {
    log("building the web app (demo on, local Supabase)");
    run(bin(WEB, "next"), ["build"], { cwd: WEB, env: { ...process.env, ...publicEnv }, quiet: true });
  }

  log(`starting the web app on ${webPort}`);
  const { WEB_CHAT_DAILY_CAP: _cap, ...inherited } = process.env; // left unset: no daily chat cap
  start(bin(WEB, "next"), ["start", "--port", String(webPort), "--hostname", "127.0.0.1"], WEB, {
    ...inherited, ...publicEnv, SUPABASE_SERVICE_ROLE_KEY: sb.service, HAGGLE_MCP_URL: `http://127.0.0.1:${mcpPort}`,
    HAGGLE_SERVICE_TOKEN: service, ANTHROPIC_API_KEY: "fake-key-for-local-tests", ANTHROPIC_BASE_URL: fake.url,
  }, "web");
  await waitFor(`http://127.0.0.1:${webPort}/terms`, "the web app");

  log("running e2e/guest-deal.spec.ts");
  // Async: the fake Claude answers from this process, so its event loop must keep running.
  const pw = spawn(shellCmd(bin(WEB, "playwright")), ["test", "e2e/guest-deal.spec.ts"], {
    cwd: WEB, stdio: "inherit", shell: WIN, env: { ...process.env, HAGGLE_E2E_TIER2: "1", E2E_BASE_URL: `http://127.0.0.1:${webPort}` },
  });
  const status = await new Promise<number>((resolve) => pw.on("exit", (c) => resolve(c ?? 1)));
  log(`fake Claude tool calls: ${JSON.stringify(fake.calls)}; server logs in ${LOGS}`);
  await fake.close();
  return status;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error(`[tier2] ${e instanceof Error ? e.message : String(e)}`);
} finally {
  stopAll();
  if (!keep) {
    log("stopping local Supabase");
    spawnSync("npx", ["--yes", SUPABASE_CLI, "stop", "--no-backup", "--workdir", "apps/web/e2e"], { cwd: ROOT, stdio: "ignore", shell: WIN });
  }
}
process.exit(code);
