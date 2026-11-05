// Production deploy in one command, from the repo root on a clean, pushed main:
//   npm run deploy               MCP server (Manufact), then web app (Vercel)
//   npm run deploy -- --mcp      MCP server only
//   npm run deploy -- --web      web app only
//   npm run deploy -- --dry-run  every check, nothing deployed
// Both hosts upload what is on disk, so this refuses to run unless disk, main and origin/main are the same
// commit and CI passed on it. Server env vars are left as they are. Reads the gitignored .env.prod-keys,
// .env.prod-state, .env.deploy, .mcp-use/cloud/link.json and .vercel/project.json. Never prints a secret.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

process.chdir(join(dirname(fileURLToPath(import.meta.url)), ".."));

const FLAGS = new Set(["--mcp", "--web", "--dry-run"]);
const flags = new Set(process.argv.slice(2));
for (const f of flags) if (!FLAGS.has(f)) fail(`Unknown option ${f}. Use --mcp, --web or --dry-run.`);
const dryRun = flags.has("--dry-run");
const doMcp = flags.has("--mcp") || !flags.has("--web");
const doWeb = flags.has("--web") || !flags.has("--mcp");

const CI_WAIT_MS = 20 * 60_000;
const BUILD_WAIT_MS = 15 * 60_000;
const READY_WAIT_MS = 3 * 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`\nSTOPPED: ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}
const git = (...args) => run("git", args).out;
const mcpUse = (...args) => run(process.execPath, ["node_modules/@mcp-use/cli/dist/bin.js", ...args]);

function readEnv(file) {
  const vars = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return vars;
}

let failures = 0;
function check(name, ok, fix) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` - ${fix}`}`);
  if (ok) return;
  failures += 1;
  if (!dryRun) fail(fix);
}

async function ciConclusion(sha) {
  const started = Date.now();
  for (;;) {
    const r = run("gh", ["run", "list", "--commit", sha, "--workflow", "CI", "--limit", "1", "--json", "status,conclusion"]);
    if (!r.ok) return "gh failed (is the GitHub CLI signed in?)";
    const latest = JSON.parse(r.out || "[]")[0];
    if (!latest) return "no CI run for this commit";
    if (latest.status === "completed") return latest.conclusion;
    if (dryRun) return `still ${latest.status}`;
    if (Date.now() - started > CI_WAIT_MS) return "timed out waiting for CI";
    console.log(`      CI ${latest.status}, waiting...`);
    await sleep(20_000);
  }
}

function deployments(serverId) {
  const r = mcpUse("deployments", "list", "--server", serverId, "--limit", "10", "--json");
  if (!r.ok) fail("Could not list Manufact deployments. Run: npx mcp-use login");
  return JSON.parse(r.out).items;
}

async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return { status: res.status, body: await res.json() };
  } catch {
    return { status: 0, body: null };
  }
}

async function deployMcp(sha, serverId, mcpUrl) {
  const before = deployments(serverId);
  const live = before.find((d) => d.status === "running");
  console.log(`\nMCP server: replacing ${live?.name ?? "nothing running"} (rollback point: ${live?.id ?? "none"})`);
  for (const [k, v] of [["HAGGLE_BUILD_SHA", sha], ["HAGGLE_BUILD_TIME", new Date().toISOString().replace(/\.\d+Z$/, "Z")]]) {
    if (!mcpUse("servers", "env", "set", serverId, `${k}=${v}`, "--json").ok) fail(`Could not set ${k} on the server.`);
  }
  if (!mcpUse("deploy", "--json").ok) fail("mcp-use deploy failed. Nothing changed on the running server.");

  // One deploy creates two deployments and one of them stops, so watch the newest one that is new.
  const known = new Set(before.map((d) => d.id));
  const started = Date.now();
  for (;;) {
    const fresh = deployments(serverId).filter((d) => !known.has(d.id)).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const newest = fresh[0];
    if (newest?.status === "running") {
      console.log(`      ${newest.name} running`);
      break;
    }
    if (newest && /fail|error/i.test(newest.status)) fail(`${newest.name} ${newest.status}. Read: npx mcp-use deployments logs ${newest.id} --build`);
    if (Date.now() - started > BUILD_WAIT_MS) fail("Timed out waiting for the Manufact build. Check the dashboard.");
    await sleep(12_000);
  }

  const readyFrom = Date.now();
  for (;;) {
    const { body } = await getJson(`${mcpUrl}/ready`);
    if (body?.ready === true && body.build_sha === sha) {
      console.log(`PASS  server ready on ${sha}, ${body.checks?.migrations?.applied} migrations applied`);
      return;
    }
    if (Date.now() - readyFrom > READY_WAIT_MS) fail(`/ready did not report ready on ${sha} (last build ${body?.build_sha ?? "unknown"}). Rollback: docs/production-deploy.md section 9.`);
    await sleep(6_000);
  }
}

async function deployWeb(sha, appUrl, vercelToken, project) {
  const list = `https://api.vercel.com/v6/deployments?projectId=${project.projectId}&teamId=${project.orgId}&target=production&limit=1`;
  const headers = { Authorization: `Bearer ${vercelToken}` };
  const previous = (await (await fetch(list, { headers })).json()).deployments?.[0];
  console.log(`\nWeb app: replacing ${previous?.uid ?? "nothing"} (rollback: promote it in Vercel)`);
  const r = spawnSync("npx", ["--yes", "vercel@latest", "deploy", "--prod", "--yes"], { stdio: "inherit", shell: true, env: { ...process.env, VERCEL_TOKEN: vercelToken } });
  if (r.status !== 0) fail("vercel deploy failed. The previous web deployment is still live.");
  const latest = (await (await fetch(list, { headers })).json()).deployments?.[0];
  const state = latest?.state ?? latest?.readyState;
  if (state !== "READY" || latest?.meta?.gitCommitSha?.slice(0, sha.length) !== sha) fail(`Vercel's latest production deployment is ${state} on ${latest?.meta?.gitCommitSha?.slice(0, 7) ?? "unknown"}, not ${sha}.`);
  const { body } = await getJson(`${appUrl}/api/health`);
  if (body?.ok !== true || body.mcp?.reachable !== true) fail(`${appUrl}/api/health is not ok. Rollback: promote ${previous?.uid} in Vercel.`);
  console.log(`PASS  web app live on ${sha}, reaching the MCP server`);
}

const required = [".env.deploy", ".env.prod-keys", ".env.prod-state", ".mcp-use/cloud/link.json", ".vercel/project.json"];
const missing = required.filter((f) => !existsSync(f));
if (missing.length) fail(`Missing ${missing.join(", ")}. These are gitignored: restore them from your backup.`);
const keys = readEnv(".env.prod-keys");
const state = readEnv(".env.prod-state");
const { serverId } = JSON.parse(readFileSync(".mcp-use/cloud/link.json", "utf8"));
const project = JSON.parse(readFileSync(".vercel/project.json", "utf8"));
const appUrl = `https://${state.APP_DOMAIN}`;
const mcpUrl = (state.MCP_URL ?? "").replace(/\/mcp\/?$/, "");

git("fetch", "origin", "main");
const sha = git("rev-parse", "--short", "HEAD");
const clean = () => git("status", "--porcelain") === "";

check("on main", git("branch", "--show-current") === "main", "Switch to main: git checkout main");
check("nothing uncommitted", clean(), "Commit or remove these first (both hosts upload what is on disk):\n" + git("status", "--short"));
check("main matches origin/main", git("rev-parse", "HEAD") === git("rev-parse", "origin/main"), "Push or pull main so it matches origin/main.");
const ci = await ciConclusion(git("rev-parse", "HEAD"));
check(`CI on ${sha}`, ci === "success", `CI: ${ci}`);
if (doMcp) check("signed in to Manufact", mcpUse("whoami").ok, "Run: npx mcp-use login");
if (doWeb) check("Vercel token present", Boolean(keys.VERCEL_TOKEN), "Add VERCEL_TOKEN to .env.prod-keys");

if (doMcp) {
  check("build", run("npm", ["run", "build"], { shell: true }).ok, "npm run build failed.");
  check("build left the repo clean", clean(), "The build changed tracked files:\n" + git("status", "--short"));
  const gate = run("npx", ["tsx", "apps/mcp/scripts/launch-gate.ts", "--target", "production", "--env-file", ".env.deploy", "--db-url-env", "SUPABASE_DB_URL"], { shell: true });
  check("launch gate", gate.ok, `Launch gate failed:\n${gate.out}`);
}

if (dryRun) {
  console.log(failures ? `\nDry run: ${failures} check(s) failed. Nothing was deployed.` : "\nDry run: all checks passed. Nothing was deployed.");
  process.exit(failures ? 1 : 0);
}

if (doMcp) await deployMcp(sha, serverId, mcpUrl);
if (doWeb) await deployWeb(sha, appUrl, keys.VERCEL_TOKEN, project);
console.log(`\nDeployed ${sha}. Add a line to CHECKLIST.md.`);
