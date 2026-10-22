// Operator-only workspace changes, run with direct database access (never through an MCP tool):
// who approves and how much may be spent are set here, because a model that could set them could
// approve its own purchases. Also revokes or rotates a workspace's credentials.
//
//   node --env-file=.env scripts/workspace-admin.ts revoke --id ws_acme
//   node --env-file=.env scripts/workspace-admin.ts rotate --id ws_acme [--base-url https://<server>]
//   node --env-file=.env scripts/workspace-admin.ts set-approver --id ws_acme [--phone +14155550123] [--email ops@acme.example]
//   node --env-file=.env scripts/workspace-admin.ts set-cap --id ws_acme --usd 1500
//
// Needs SUPABASE_DB_URL (the engine database, migrations through 105 applied).
import { PostgresRepository } from "@haggle/engine";
import { hashSecret, newSecret } from "../src/workspace.ts";

export type AdminCommand =
  | { kind: "revoke"; id: string }
  | { kind: "rotate"; id: string; baseUrl: string }
  | { kind: "set-approver"; id: string; phone?: string | null; email?: string | null }
  | { kind: "set-cap"; id: string; capCents: number };

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Validate a command line (pure). "--phone none" / "--email none" clears that approver. */
export function planAdmin(argv: string[]): AdminCommand {
  const [kind] = argv;
  const id = arg(argv, "id") ?? "";
  if (!/^ws_[a-z0-9_]{3,40}$/.test(id)) throw new Error("--id must be a workspace id like ws_acme");
  if (kind === "revoke") return { kind, id };
  if (kind === "rotate") return { kind, id, baseUrl: (arg(argv, "base-url") ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "") };
  if (kind === "set-approver") {
    const phone = arg(argv, "phone");
    const email = arg(argv, "email");
    if (phone === undefined && email === undefined) throw new Error("set-approver needs --phone and/or --email");
    if (phone && phone !== "none" && !/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error("--phone must be E.164, e.g. +14155550123");
    if (email && email !== "none" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email is not an email address");
    return { kind, id, ...(phone !== undefined ? { phone: phone === "none" ? null : phone } : {}), ...(email !== undefined ? { email: email === "none" ? null : email.toLowerCase() } : {}) };
  }
  if (kind === "set-cap") {
    const usd = Number(arg(argv, "usd"));
    if (!(usd > 0)) throw new Error("--usd must be a positive amount");
    return { kind, id, capCents: Math.round(usd * 100) };
  }
  throw new Error("command must be one of: revoke, rotate, set-approver, set-cap");
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planAdmin(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  try {
    if (!(await repo.getWorkspace(cmd.id))) throw new Error(`no workspace ${cmd.id}`);
    if (cmd.kind === "revoke") {
      await repo.setWorkspaceCredentials(cmd.id, { revoked: true });
      console.log(`Workspace ${cmd.id} revoked: its bearer token and connector URL no longer work. Run rotate to issue new ones.`);
    } else if (cmd.kind === "rotate") {
      const token = newSecret("hgw");
      const secret = newSecret("hgc");
      await repo.setWorkspaceCredentials(cmd.id, { token_hash: hashSecret(token), connector_secret_hash: hashSecret(secret), revoked: false });
      console.log([`Workspace ${cmd.id}: new credentials (the old ones no longer work). Save these now; they can't be shown again.`, "", `  Bearer token:   ${token}`, `  Connector URL:  ${cmd.baseUrl}/c/${secret}/mcp`].join("\n"));
    } else {
      const cur = await repo.getSettings(cmd.id);
      if (!cur) throw new Error(`workspace ${cmd.id} has no settings row`);
      const { updated_at: _u, ...row } = cur;
      const next = cmd.kind === "set-cap" ? { ...row, spending_cap_cents: cmd.capCents }
        : { ...row, ...(cmd.phone !== undefined ? { approver_phone: cmd.phone } : {}), ...(cmd.email !== undefined ? { approver_email: cmd.email } : {}) };
      await repo.saveSettings(next, cmd.id);
      console.log(cmd.kind === "set-cap" ? `Workspace ${cmd.id}: spending cap $${(cmd.capCents / 100).toFixed(2)} per payment (the server ceiling still applies).` : `Workspace ${cmd.id}: approver ${next.approver_phone ?? "no phone"} / ${next.approver_email ?? "no email"}.`);
    }
  } finally {
    await repo.close();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/workspace-admin.ts")) {
  main().catch((e) => {
    console.error(`workspace-admin failed: ${(e as Error).message}`);
    process.exit(1);
  });
}
