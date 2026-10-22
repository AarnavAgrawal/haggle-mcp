// Operator-only workspace changes, run with direct database access (never through an MCP tool):
// who approves and how much may be spent are set here, because a model that could set them could
// approve its own purchases. Also revokes or rotates a workspace's credentials.
//
//   node --env-file=.env scripts/workspace-admin.ts revoke --id ws_acme
//   node --env-file=.env scripts/workspace-admin.ts rotate --id ws_acme [--base-url https://<server>]
//   node --env-file=.env scripts/workspace-admin.ts set-approver --id ws_acme [--phone +14155550123] [--email ops@acme.example]
//   node --env-file=.env scripts/workspace-admin.ts set-cap --id ws_acme --usd 1500
//   node --env-file=.env scripts/workspace-admin.ts add-vendor --id ws_acme --contact orders@caterer.example --name "Caterer" --consent "Owner agreed by phone 2026-10-20"
//   node --env-file=.env scripts/workspace-admin.ts remove-vendor --id ws_acme --contact orders@caterer.example
//   node --env-file=.env scripts/workspace-admin.ts list-vendors --id ws_acme
//
// A workspace's deals may contact only the server allowlist plus the vendors added here, each with
// the consent it rests on. Opted-out or bounced contacts are never contacted, whatever this says.
//
// Needs SUPABASE_DB_URL (the engine database, migrations through 105 applied).
import { PostgresRepository } from "@haggle/engine";
import { hashSecret, newSecret } from "../src/workspace.ts";

export type AdminCommand =
  | { kind: "revoke"; id: string }
  | { kind: "rotate"; id: string; baseUrl: string }
  | { kind: "set-approver"; id: string; phone?: string | null; email?: string | null }
  | { kind: "set-cap"; id: string; capCents: number }
  | { kind: "add-vendor"; id: string; contact: string; name: string; consent: string }
  | { kind: "remove-vendor"; id: string; contact: string }
  | { kind: "list-vendors"; id: string };

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
  if (kind === "add-vendor" || kind === "remove-vendor") {
    const raw = (arg(argv, "contact") ?? "").trim();
    const contact = raw.includes("@") ? raw.toLowerCase() : raw.replace(/[\s().-]/g, "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^\+[1-9]\d{6,14}$/.test(contact)) throw new Error("--contact must be an email address or an E.164 phone number");
    if (kind === "remove-vendor") return { kind, id, contact };
    const name = (arg(argv, "name") ?? "").trim();
    const consent = (arg(argv, "consent") ?? "").trim();
    if (!name) throw new Error("--name is required");
    if (consent.length < 3) throw new Error("--consent is required: who agreed to be contacted, how and when");
    return { kind, id, contact, name: name.slice(0, 120), consent: consent.slice(0, 500) };
  }
  if (kind === "list-vendors") return { kind, id };
  throw new Error("command must be one of: revoke, rotate, set-approver, set-cap, add-vendor, remove-vendor, list-vendors");
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
    } else if (cmd.kind === "add-vendor") {
      await repo.addWorkspaceVendor({ workspace_id: cmd.id, contact: cmd.contact, name: cmd.name, consent: cmd.consent, added_by: "operator (workspace-admin)" });
      const [s] = await repo.findSuppressions([cmd.contact]);
      console.log(`Workspace ${cmd.id}: ${cmd.name} <${cmd.contact}> authorized (consent: ${cmd.consent}).${s ? ` Note: this contact is suppressed (${s.reason}); Haggle still won't contact it.` : ""}`);
    } else if (cmd.kind === "remove-vendor") {
      console.log((await repo.removeWorkspaceVendor(cmd.id, cmd.contact)) ? `Workspace ${cmd.id}: ${cmd.contact} no longer authorized.` : `Workspace ${cmd.id}: ${cmd.contact} wasn't authorized.`);
    } else if (cmd.kind === "list-vendors") {
      const list = await repo.listWorkspaceVendors(cmd.id);
      console.log(list.length ? list.map((v) => `${v.name} <${v.contact}> · consent: ${v.consent} · added ${v.created_at}`).join("\n") : `Workspace ${cmd.id}: no vendors authorized.`);
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
