// Create a workspace (a tenant) on a live server's database and print its credentials ONCE: a
// bearer token for Claude Code / API clients, and a connector URL (/c/<secret>/mcp) for Claude and
// ChatGPT custom connectors. Only SHA-256 hashes are stored. Ported from haggle-testing
// scripts/createWorkspace.ts (minus the per-workspace Inkbox identity: every workspace shares the
// `haggle` buyer identity).
//
//   node --env-file=.env scripts/workspace-create.ts --name "Acme ops" --approver-phone +14155550123 --cap 1500 \
//     [--id ws_acme] [--approver-email ops@acme.example] [--area "San Francisco, CA"] \
//     [--timezone America/Los_Angeles] [--base-url https://<server>] [--allow-shared-approver] \
//     [--apply --by "<you>" (--credentials-file <new file> | --print-credentials)]
//
// Dry run by default: validates, checks the database (existing id, shared approver) and prints what
// it would do; nothing is written and no secret is shown. --apply creates it. Idempotent: re-running
// for a workspace that already exists with the same settings changes nothing and issues no new
// credentials (rotate does that); different settings are refused with the commands that change them.
// Credentials go to --credentials-file (created 0600, never overwritten) and stdout shows only how to
// hand them over; --print-credentials prints them once instead. The output ends with the readiness
// check; then scripts/pilot-preflight.ts --workspace <id> runs the full pilot checks.
//
// One command: the workspace, its human approver and spending cap, and its credentials (printed once).
// Live approvals are only the approver's coded text, so a workspace without --approver-phone can't
// approve anything (it is created, with a warning). An approver phone that already approves for
// another workspace is refused unless --allow-shared-approver: Haggle has one text line, so a reply
// from a shared number is held until the human adds the deal code.
//
// Needs SUPABASE_DB_URL (the engine database, migrations through 108 applied). Live servers always
// refuse requests without a workspace credential. Vendors: scripts/workspace-admin.ts add-vendor.
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { PostgresRepository, type Repository } from "@haggle/engine";
import { hashSecret, newSecret } from "../src/workspace.ts";
import { unlinkSync, writeFileSync } from "node:fs";
import { recordOperatorAction, RESERVED_WORKSPACE_IDS } from "@haggle/engine";
import { connectionLines, readiness, readinessText, sharedApproverProblem, showData, type AdminRepo } from "./workspace-admin.ts";

export interface WorkspaceArgs {
  name: string;
  id?: string;
  timezone?: string;
  capUsd?: number;
  approverPhone?: string;
  approverEmail?: string;
  area?: string;
  baseUrl?: string;
  allowSharedApprover?: boolean;
}

/** Validate the arguments and mint fresh credentials (pure apart from randomness). */
export function planWorkspace(a: WorkspaceArgs) {
  if (!a.name?.trim()) throw new Error("--name is required");
  const id = a.id ?? `ws_${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "workspace"}`;
  if (!/^ws_[a-z0-9_]{3,40}$/.test(id)) throw new Error(`workspace id must look like ws_acme (got ${id})`);
  if (RESERVED_WORKSPACE_IDS.includes(id)) throw new Error(`workspace id ${id} is reserved (the brain's pre-tenancy profiles, 202_brain_tenancy); pass another --id`);
  if (a.approverPhone && !/^\+[1-9]\d{6,14}$/.test(a.approverPhone)) throw new Error("--approver-phone must be E.164, e.g. +14155550123");
  if (a.approverEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.approverEmail)) throw new Error("--approver-email is not an email address");
  if (a.capUsd !== undefined && !(a.capUsd > 0)) throw new Error("--cap must be a positive amount in USD");
  const timezone = a.timezone ?? "America/Los_Angeles";
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }); // throws on an unknown timezone
  const token = newSecret("hgw");
  const secret = newSecret("hgc");
  const base = (a.baseUrl ?? "http://localhost:3000").replace(/\/+$/, "");
  return {
    workspace: { id, name: a.name.trim().slice(0, 120), token_hash: hashSecret(token), connector_secret_hash: hashSecret(secret), timezone },
    settings: {
      spending_cap_cents: Math.round((a.capUsd ?? 1500) * 100), approver_phone: a.approverPhone ?? null,
      approver_email: a.approverEmail?.toLowerCase() ?? null, default_area: a.area ?? null,
    },
    token, connectorUrl: `${base}/c/${secret}/mcp`, mcpUrl: `${base}/mcp`,
    warnings: a.approverPhone ? [] : ["No --approver-phone: on a live server nothing in this workspace can be approved until workspace-admin set-approver gives it one."],
  };
}

/** The repository calls creation needs (PostgresRepository in production; the in-memory one in tests). */
export type CreateRepo = AdminRepo & Pick<Repository, "insertWorkspace">;

/**
 * Create the planned workspace: refuses an existing id and an approver phone already approving for
 * another workspace (unless allowed). Returns the text to print ONCE (credentials, client connection
 * details, the readiness check and the next steps).
 */
export async function createWorkspace(plan: ReturnType<typeof planWorkspace>, repo: CreateRepo, opts: { allowSharedApprover?: boolean } = {}): Promise<string> {
  if (RESERVED_WORKSPACE_IDS.includes(plan.workspace.id)) throw new Error(`workspace id ${plan.workspace.id} is reserved; pass another --id`);
  if (await repo.getWorkspace(plan.workspace.id)) throw new Error(`workspace ${plan.workspace.id} already exists (use workspace-admin.ts to change it)`);
  const problem = sharedApproverProblem(plan.settings.approver_phone, plan.workspace.id, plan.settings.approver_phone ? await repo.listWorkspacesByApproverPhone(plan.settings.approver_phone) : [], opts.allowSharedApprover);
  if (problem) throw new Error(problem);
  await repo.insertWorkspace(plan.workspace);
  await repo.saveSettings(plan.settings, plan.workspace.id);
  const ready = readiness(await showData(repo, plan.workspace.id));
  const secret = plan.connectorUrl.match(/\/c\/([^/]+)\/mcp$/)![1]!;
  return [
    `Workspace ${plan.workspace.id} (${plan.workspace.name}) created, timezone ${plan.workspace.timezone}. Save these now; they are not stored and can't be shown again.`,
    "",
    ...connectionLines(plan.mcpUrl.replace(/\/mcp$/, ""), plan.token, secret),
    "",
    "Live servers always refuse requests without a workspace credential (mock: set HAGGLE_AUTH=required). Change the approver or cap, revoke or rotate with scripts/workspace-admin.ts.",
    ...(plan.settings.approver_phone ? ["For iMessage approvals the approver texts `connect @haggle` to Inkbox's router number once (not needed when approvals go by SMS)."] : []),
    `Approver ${plan.settings.approver_phone ?? "none"}; spending cap $${(plan.settings.spending_cap_cents / 100).toFixed(2)} per payment; default area ${plan.settings.default_area ?? "none"}.`,
    `Next: add each vendor with its consent: scripts/workspace-admin.ts add-vendor --id ${plan.workspace.id} --contact <email or +1...> --name "<Vendor>" --consent "<who agreed, how, when>" [--channel email|phone|text]; then check: show --id ${plan.workspace.id}.`,
    "",
    ...readinessText(ready),
    ...plan.warnings.map((w) => `WARNING: ${w}`),
  ].join("\n");
}

export interface ProvisionOptions {
  apply: boolean;
  by?: string;
  allowSharedApprover?: boolean;
  /** Where the credentials go on --apply: a new 0600 file (stdout then shows no secret), or stdout once. */
  credentials?: { file: string } | { print: true };
  /** HAGGLE_ENV of the database's deployment (labels the output; a localhost URL is flagged outside development). */
  env?: string;
  /** Test seam: writes the credentials file (default: 0600, refuses an existing file). */
  writeFile?: (path: string, text: string) => void;
}

/** What differs between the plan and an existing workspace (empty: already provisioned as asked). */
export function provisionDiff(plan: ReturnType<typeof planWorkspace>, ws: { name: string; timezone: string }, s: { spending_cap_cents: number; approver_phone: string | null; approver_email: string | null; default_area: string | null } | null): string[] {
  const id = plan.workspace.id;
  const p = plan.settings;
  return [
    ...(ws.name !== plan.workspace.name ? [`name is "${ws.name}" (asked "${plan.workspace.name}"): names aren't changed by a script`] : []),
    ...(ws.timezone !== plan.workspace.timezone ? [`timezone is ${ws.timezone} (asked ${plan.workspace.timezone})`] : []),
    ...(!s ? [`no settings row: workspace-admin.ts set-cap --id ${id} --usd ${(p.spending_cap_cents / 100).toFixed(2)}`] : [
      ...(s.approver_phone !== p.approver_phone ? [`approver phone is ${s.approver_phone ?? "none"} (asked ${p.approver_phone ?? "none"}): workspace-admin.ts set-approver --id ${id} --phone ${p.approver_phone ?? "none"}`] : []),
      ...(s.approver_email !== p.approver_email ? [`approver email differs: workspace-admin.ts set-approver --id ${id} --email ${p.approver_email ?? "none"}`] : []),
      ...(s.spending_cap_cents !== p.spending_cap_cents ? [`cap is $${(s.spending_cap_cents / 100).toFixed(2)} (asked $${(p.spending_cap_cents / 100).toFixed(2)}): workspace-admin.ts set-cap --id ${id} --usd ${(p.spending_cap_cents / 100).toFixed(2)}`] : []),
      ...(s.default_area !== p.default_area ? [`default area is ${s.default_area ?? "none"} (asked ${p.default_area ?? "none"}): change it in the client's settings panel or re-create`] : []),
    ]),
  ];
}

/** How to hand the credentials over, without showing them (they are in the credentials file). */
export function connectionInstructions(baseUrl: string, file: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    `  MCP endpoint:   ${base}/mcp`,
    `  Bearer token and connector URL: in ${file} (0600). Not shown here.`,
    "",
    "  Hand-over: send the file's contents to the customer over a channel meant for secrets (a password manager share), then delete the file.",
    "  The connector URL IS the credential: it goes only into the customer's Claude or ChatGPT custom-connector settings, never into a chat, an email body, a ticket or a screenshot.",
    `  Claude Code:    claude mcp add --transport http haggle ${base}/mcp --header "Authorization: Bearer <token from the file>"`,
    "  Lost or leaked: workspace-admin.ts revoke (immediate), then rotate for new ones.",
  ];
}

const writeSecretFile = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600, flag: "wx" });

/**
 * One-command pilot provisioning: dry run unless opts.apply; idempotent for an existing workspace
 * with the same settings; refuses different settings. Returns the text to print (secrets only with
 * print: true) and whether anything was created.
 */
export async function provisionWorkspace(plan: ReturnType<typeof planWorkspace>, repo: CreateRepo, opts: ProvisionOptions): Promise<{ text: string; created: boolean }> {
  const id = plan.workspace.id;
  if (RESERVED_WORKSPACE_IDS.includes(id)) throw new Error(`workspace id ${id} is reserved; pass another --id`);
  const base = plan.mcpUrl.replace(/\/mcp$/, "");
  const envLabel = opts.env ?? "development";
  const notes = [
    ...(envLabel !== "development" && /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base) ? [`WARNING: --base-url (or PUBLIC_BASE_URL) is ${base} on a ${envLabel} database: the customer's client needs the public server URL.`] : []),
    ...plan.warnings.map((w) => `WARNING: ${w}`),
  ];
  const existing = await repo.getWorkspace(id);
  if (existing) {
    const diff = provisionDiff(plan, existing, await repo.getSettings(id));
    if (diff.length) throw new Error(`workspace ${id} already exists with different settings; nothing changed:\n  - ${diff.join("\n  - ")}`);
    return { created: false, text: [`Workspace ${id} (${existing.name}) already exists with these settings [${envLabel}]: nothing changed, no new credentials (workspace-admin.ts rotate issues new ones).`, "", ...readinessText(readiness(await showData(repo, id))), ...notes].join("\n") };
  }
  const problem = sharedApproverProblem(plan.settings.approver_phone, id, plan.settings.approver_phone ? await repo.listWorkspacesByApproverPhone(plan.settings.approver_phone) : [], opts.allowSharedApprover);
  if (problem) throw new Error(problem);
  const summary = `${id} (${plan.workspace.name}), timezone ${plan.workspace.timezone}; approver ${plan.settings.approver_phone ?? "none"}${plan.settings.approver_email ? ` / ${plan.settings.approver_email}` : ""}; cap $${(plan.settings.spending_cap_cents / 100).toFixed(2)} per payment; default area ${plan.settings.default_area ?? "none"}; server ${base}`;
  if (!opts.apply) {
    return { created: false, text: [`DRY RUN [${envLabel}]: would create workspace ${summary}. Nothing was written and no credentials were issued.`, `Re-run with --apply --by "<you>" --credentials-file <new file> (or --print-credentials) to create it.`, ...notes].join("\n") };
  }
  if (!opts.by || opts.by.trim().length < 2) throw new Error("--by is required with --apply: who is creating the workspace; it is recorded");
  if (!opts.credentials) throw new Error("--apply needs --credentials-file <new file> (recommended: stdout shows no secret) or --print-credentials (shown once on stdout)");
  const file = "file" in opts.credentials ? opts.credentials.file : null;
  const secret = plan.connectorUrl.match(/\/c\/([^/]+)\/mcp$/)![1]!;
  if (file) (opts.writeFile ?? writeSecretFile)(file, [`# Haggle workspace ${id} credentials (${envLabel}). Treat as a password; delete after hand-over.`, ...connectionLines(base, plan.token, secret), ""].join("\n"));
  try {
    await repo.insertWorkspace(plan.workspace);
    await repo.saveSettings(plan.settings, id);
  } catch (e) {
    if (file && !opts.writeFile) try { unlinkSync(file); } catch { /* nothing to remove */ }
    throw e;
  }
  let logged = "";
  try {
    await recordOperatorAction(repo, { action: "workspace_created", operator: opts.by, reason: `pilot workspace created: ${plan.workspace.name}`, workspaceId: id, detail: { approver_phone: plan.settings.approver_phone, cap_cents: plan.settings.spending_cap_cents, area: plan.settings.default_area, timezone: plan.workspace.timezone } });
  } catch (e) {
    logged = `WARNING: created, but not recorded in the operator log (${(e as Error).message}).`;
  }
  const ready = readiness(await showData(repo, id));
  return {
    created: true,
    text: [
      `Workspace ${summary} created [${envLabel}].`,
      "",
      ...(file ? connectionInstructions(base, file) : [`Save these now; they are not stored and can't be shown again.`, ...connectionLines(base, plan.token, secret)]),
      "",
      ...(plan.settings.approver_phone ? ["For iMessage approvals the approver texts `connect @haggle` to Inkbox's router number once (not needed when approvals go by SMS)."] : []),
      `Next: verify the approver (workspace-admin.ts verify-approver --id ${id} --phone ${plan.settings.approver_phone ?? "+1..."} --by <you> --how "<how>"), add at least 3 consenting vendors (workspace-admin.ts add-vendor --id ${id} --contact <email or +1...> --name "<Vendor>" --consent "<who agreed, how, when>" --by <you>), then scripts/pilot-preflight.ts --target <staging|production> --env-file <file> --db-url-env SUPABASE_DB_URL --workspace ${id}.`,
      ...(logged ? [logged] : []),
      "",
      ...readinessText(ready),
      ...notes,
    ].join("\n"),
  };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv = process.argv.slice(2)) {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const cap = arg(argv, "cap");
  const base = arg(argv, "base-url") ?? process.env.PUBLIC_BASE_URL;
  const plan = planWorkspace({
    name: arg(argv, "name") ?? "", ...(arg(argv, "id") ? { id: arg(argv, "id")! } : {}), ...(arg(argv, "timezone") ? { timezone: arg(argv, "timezone")! } : {}),
    ...(cap ? { capUsd: Number(cap) } : {}), ...(arg(argv, "approver-phone") ? { approverPhone: arg(argv, "approver-phone")! } : {}),
    ...(arg(argv, "approver-email") ? { approverEmail: arg(argv, "approver-email")! } : {}), ...(arg(argv, "area") ? { area: arg(argv, "area")! } : {}),
    ...(base ? { baseUrl: base } : {}), ...(argv.includes("--allow-shared-approver") ? { allowSharedApprover: true } : {}),
  });
  const apply = argv.includes("--apply");
  const file = arg(argv, "credentials-file");
  if (argv.includes("--credentials-file") && !file) throw new Error("--credentials-file needs a path (a new file)");
  if (file && argv.includes("--print-credentials")) throw new Error("use one of --credentials-file or --print-credentials");
  const by = (arg(argv, "by") ?? "").trim();
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  try {
    const r = await provisionWorkspace(plan, repo, {
      apply, ...(by ? { by } : {}), allowSharedApprover: argv.includes("--allow-shared-approver"), env: process.env.HAGGLE_ENV?.trim() || "development",
      ...(file ? { credentials: { file } } : argv.includes("--print-credentials") ? { credentials: { print: true as const } } : {}),
    });
    console.log(r.text);
  } finally {
    await repo.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/workspace-create.ts")) {
  main().catch((e) => {
    console.error(`workspace-create failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
