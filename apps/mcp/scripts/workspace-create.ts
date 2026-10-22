// Create a workspace (a tenant) on a live server's database and print its credentials ONCE: a
// bearer token for Claude Code / API clients, and a connector URL (/c/<secret>/mcp) for Claude and
// ChatGPT custom connectors. Only SHA-256 hashes are stored. Ported from haggle-testing
// scripts/createWorkspace.ts (minus the per-workspace Inkbox identity: every workspace shares the
// `haggle` buyer identity).
//
//   node --env-file=.env scripts/workspace-create.ts --name "Acme ops" --approver-phone +14155550123 --cap 1500 \
//     [--id ws_acme] [--approver-email ops@acme.example] [--area "San Francisco, CA"] \
//     [--timezone America/Los_Angeles] [--base-url https://<server>] [--allow-shared-approver]
//
// One command: the workspace, its human approver and spending cap, and its credentials (printed once).
// Live approvals are only the approver's coded text, so a workspace without --approver-phone can't
// approve anything (it is created, with a warning). An approver phone that already approves for
// another workspace is refused unless --allow-shared-approver: Haggle has one text line, so a reply
// from a shared number is held until the human adds the deal code.
//
// Needs SUPABASE_DB_URL (the engine database, migrations through 108 applied). Live servers always
// refuse requests without a workspace credential. Vendors: scripts/workspace-admin.ts add-vendor.
import { PostgresRepository } from "@haggle/engine";
import { hashSecret, newSecret } from "../src/workspace.ts";
import { sharedApproverProblem } from "./workspace-admin.ts";

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
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  try {
    if (await repo.getWorkspace(plan.workspace.id)) throw new Error(`workspace ${plan.workspace.id} already exists (use workspace-admin.ts to change it)`);
    const problem = sharedApproverProblem(plan.settings.approver_phone, plan.workspace.id, plan.settings.approver_phone ? await repo.listWorkspacesByApproverPhone(plan.settings.approver_phone) : [], argv.includes("--allow-shared-approver"));
    if (problem) throw new Error(problem);
    await repo.insertWorkspace(plan.workspace);
    await repo.saveSettings(plan.settings, plan.workspace.id);
  } finally {
    await repo.close();
  }
  console.log([
    `Workspace ${plan.workspace.id} (${plan.workspace.name}) created. Save these now; they are not stored and can't be shown again.`,
    "",
    `  Bearer token:   ${plan.token}`,
    `  Connector URL:  ${plan.connectorUrl}`,
    "",
    `  Claude Code:    claude mcp add --transport http haggle ${plan.mcpUrl} --header "Authorization: Bearer ${plan.token}"`,
    "  Claude/ChatGPT: add the connector URL as a custom connector.",
    "",
    "Live servers always refuse requests without a workspace credential (mock: set HAGGLE_AUTH=required). Change the approver or cap, revoke or rotate with scripts/workspace-admin.ts.",
    ...(plan.settings.approver_phone ? ["For iMessage approvals the approver texts `connect @haggle` to Inkbox's router number once."] : []),
    `Approver ${plan.settings.approver_phone ?? "none"}; spending cap $${(plan.settings.spending_cap_cents / 100).toFixed(2)} per payment. Add vendors: scripts/workspace-admin.ts add-vendor --id ${plan.workspace.id} ...; check with show --id ${plan.workspace.id}.`,
    ...plan.warnings.map((w) => `WARNING: ${w}`),
  ].join("\n"));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/workspace-create.ts")) {
  main().catch((e) => {
    console.error(`workspace-create failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
