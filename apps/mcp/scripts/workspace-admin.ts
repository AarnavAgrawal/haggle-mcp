// Operator-only workspace changes, run with direct database access (never through an MCP tool):
// who approves and how much may be spent are set here, because a model that could set them could
// approve its own purchases. Also revokes or rotates a workspace's credentials.
//
//   node --env-file=.env scripts/workspace-admin.ts show --id ws_acme        (settings, vendors and a PASS/FAIL readiness check; exit 1 on FAIL)
//   node --env-file=.env scripts/workspace-admin.ts revoke --id ws_acme
//   node --env-file=.env scripts/workspace-admin.ts rotate --id ws_acme [--base-url https://<server>]
//   node --env-file=.env scripts/workspace-admin.ts set-approver --id ws_acme [--phone +14155550123] [--email ops@acme.example] [--allow-shared-approver]
//   node --env-file=.env scripts/workspace-admin.ts set-cap --id ws_acme --usd 1500
//   node --env-file=.env scripts/workspace-admin.ts add-vendor --id ws_acme --contact orders@caterer.example --name "Caterer" --consent "Owner agreed by phone 2026-10-20" [--channel email|phone|text]
//   node --env-file=.env scripts/workspace-admin.ts remove-vendor --id ws_acme --contact orders@caterer.example
//   node --env-file=.env scripts/workspace-admin.ts list-vendors --id ws_acme
//   node --env-file=.env scripts/workspace-admin.ts remove-suppression --contact orders@caterer.example --by "Yash" --why "mailbox was full, not a hard bounce"
//
// A workspace's deals may contact only the server allowlist plus the vendors added here, each with
// the consent it rests on, and an agent names them by name (deal(businesses=['Caterer'])).
// Opted-out or bounced contacts are never contacted, whatever this says; remove-suppression is the
// escape hatch for a wrong one (it applies to every workspace) and records who removed it and why.
//
// Needs SUPABASE_DB_URL (the engine database, migrations through 108 applied).
import "./dbGuard.ts"; // refuses a production database outside HAGGLE_ENV=production (src/config.ts)
import { PostgresRepository, type Repository, type SettingsRow, type SuppressionRow, type WorkspaceRow, type WorkspaceVendorRow } from "@haggle/engine";
import { hashSecret, newSecret } from "../src/workspace.ts";

type VendorChannel = "email" | "phone" | "imessage";

export type AdminCommand =
  | { kind: "show"; id: string }
  | { kind: "revoke"; id: string }
  | { kind: "rotate"; id: string; baseUrl: string }
  | { kind: "set-approver"; id: string; phone?: string | null; email?: string | null; allowShared?: boolean }
  | { kind: "set-cap"; id: string; capCents: number }
  | { kind: "add-vendor"; id: string; contact: string; name: string; consent: string; channel?: VendorChannel }
  | { kind: "remove-vendor"; id: string; contact: string }
  | { kind: "list-vendors"; id: string }
  | { kind: "remove-suppression"; contact: string; by: string; why: string };

const COMMANDS = "show, revoke, rotate, set-approver, set-cap, add-vendor, remove-vendor, list-vendors, remove-suppression";

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** An email address (lowercased) or an E.164 number, else an error naming the flag. */
function contactArg(argv: string[]): string {
  const raw = (arg(argv, "contact") ?? "").trim();
  const contact = raw.includes("@") ? raw.toLowerCase() : raw.replace(/[\s().-]/g, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^\+[1-9]\d{6,14}$/.test(contact)) throw new Error("--contact must be an email address or an E.164 phone number");
  return contact;
}

/** Validate a command line (pure). "--phone none" / "--email none" clears that approver. */
export function planAdmin(argv: string[]): AdminCommand {
  const [kind] = argv;
  if (kind === "remove-suppression") {
    const contact = contactArg(argv);
    const by = (arg(argv, "by") ?? "").trim();
    const why = (arg(argv, "why") ?? "").trim();
    if (!by) throw new Error("--by is required: who is removing the suppression");
    if (why.length < 3) throw new Error("--why is required: why the opt-out or bounce was wrong (e.g. the vendor asked to be contacted again)");
    return { kind, contact, by: by.slice(0, 120), why: why.slice(0, 500) };
  }
  const id = arg(argv, "id") ?? "";
  if (!/^ws_[a-z0-9_]{3,40}$/.test(id)) throw new Error("--id must be a workspace id like ws_acme");
  if (kind === "show" || kind === "revoke" || kind === "list-vendors") return { kind, id };
  if (kind === "rotate") return { kind, id, baseUrl: (arg(argv, "base-url") ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "") };
  if (kind === "set-approver") {
    const phone = arg(argv, "phone");
    const email = arg(argv, "email");
    if (phone === undefined && email === undefined) throw new Error("set-approver needs --phone and/or --email");
    if (phone && phone !== "none" && !/^\+[1-9]\d{6,14}$/.test(phone)) throw new Error("--phone must be E.164, e.g. +14155550123");
    if (email && email !== "none" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email is not an email address");
    return { kind, id, ...(phone !== undefined ? { phone: phone === "none" ? null : phone } : {}), ...(email !== undefined ? { email: email === "none" ? null : email.toLowerCase() } : {}), ...(argv.includes("--allow-shared-approver") ? { allowShared: true } : {}) };
  }
  if (kind === "set-cap") {
    const usd = Number(arg(argv, "usd"));
    if (!(usd > 0)) throw new Error("--usd must be a positive amount");
    return { kind, id, capCents: Math.round(usd * 100) };
  }
  if (kind === "add-vendor" || kind === "remove-vendor") {
    const contact = contactArg(argv);
    if (kind === "remove-vendor") return { kind, id, contact };
    const name = (arg(argv, "name") ?? "").trim();
    const consent = (arg(argv, "consent") ?? "").trim();
    if (!name) throw new Error("--name is required");
    if (consent.length < 3) throw new Error("--consent is required: who agreed to be contacted, how and when");
    const ch = arg(argv, "channel")?.trim().toLowerCase();
    const channel: VendorChannel | undefined = ch === undefined ? undefined : ch === "text" || ch === "sms" || ch === "imessage" ? "imessage" : ch === "email" || ch === "phone" ? ch : undefined;
    if (ch !== undefined && !channel) throw new Error("--channel must be email, phone (a Voice AI call) or text");
    if (channel && (channel === "email") !== contact.includes("@")) throw new Error(`--channel ${ch} doesn't fit ${contact}: email for an address, phone or text for a number`);
    return { kind, id, contact, name: name.slice(0, 120), consent: consent.slice(0, 500), ...(channel ? { channel } : {}) };
  }
  throw new Error(`command must be one of: ${COMMANDS}`);
}

/**
 * A text from a phone that approves for two workspaces can't be routed by itself (Haggle has one
 * text line): it is held until the human adds the deal code. Refused unless the operator accepts it.
 */
export function sharedApproverProblem(phone: string | null | undefined, workspaceId: string, others: string[], allow = false): string | null {
  const clash = others.filter((w) => w !== workspaceId);
  if (!phone || !clash.length || allow) return null;
  return `${phone} already approves for ${clash.join(", ")}. Texts from a number shared by workspaces can't be routed on their own (the human must add the deal code to every reply). Use a different approver, or pass --allow-shared-approver.`;
}

const mask = (c: string) => (c.includes("@") ? c.replace(/^(.).*?@/, "$1•••@") : `${c.slice(0, 3)}•••${c.slice(-2)}`);

export interface ShowData { workspace: WorkspaceRow; settings: Omit<SettingsRow, "updated_at"> | null; vendors: WorkspaceVendorRow[]; suppressions: SuppressionRow[]; sharedApprover: string[] }

export interface ReadinessCheck { name: string; pass: boolean; detail: string; fix?: string }

/**
 * Can this workspace run a real pilot deal end to end with no developer step? Each check names what
 * is missing and the exact command that fixes it. Warnings (shared approver, no default area) don't fail it.
 */
export function readiness(d: ShowData): { ready: boolean; checks: ReadinessCheck[]; warnings: string[] } {
  const w = d.workspace;
  const id = w.id;
  const sup = new Set(d.suppressions.map((s) => s.contact));
  const consented = d.vendors.filter((v) => v.consent.trim().length >= 3);
  const suppressed = d.vendors.filter((v) => sup.has(v.contact));
  const checks: ReadinessCheck[] = [
    w.revoked_at ? { name: "credentials", pass: false, detail: `revoked ${w.revoked_at}`, fix: `workspace-admin.ts rotate --id ${id} (issues new ones)` }
      : !w.token_hash && !w.connector_secret_hash ? { name: "credentials", pass: false, detail: "none issued", fix: `workspace-admin.ts rotate --id ${id}` }
      : { name: "credentials", pass: true, detail: `active (${[w.token_hash ? "bearer token" : null, w.connector_secret_hash ? "connector URL" : null].filter(Boolean).join(" + ")})` },
    d.settings?.approver_phone ? { name: "approver", pass: true, detail: `texts to ${d.settings.approver_phone} (only their YES <code> approves)` }
      : { name: "approver", pass: false, detail: "no approver phone: nothing in this workspace can be approved on a live server", fix: `workspace-admin.ts set-approver --id ${id} --phone +1...` },
    d.settings && d.settings.spending_cap_cents > 0 ? { name: "spending cap", pass: true, detail: `$${(d.settings.spending_cap_cents / 100).toFixed(2)} per payment` }
      : { name: "spending cap", pass: false, detail: "no settings row", fix: `workspace-admin.ts set-cap --id ${id} --usd 1500` },
    consented.length ? { name: "vendors", pass: true, detail: `${consented.length} with recorded consent` }
      : { name: "vendors", pass: false, detail: "none: a deal has nobody to contact", fix: `workspace-admin.ts add-vendor --id ${id} --contact <email or +1...> --name "<Vendor>" --consent "<who agreed, how, when>"` },
    suppressed.length ? { name: "suppressions", pass: false, detail: `${suppressed.map((v) => v.name).join(", ")} opted out or bounced: never contacted`, fix: "remove the vendor (remove-vendor), or remove-suppression only if the opt-out or bounce was wrong and the vendor agreed" }
      : { name: "suppressions", pass: true, detail: "no vendor opted out or bounced" },
  ];
  const warnings = [
    ...(d.sharedApprover.length ? [`the approver phone also approves for ${d.sharedApprover.join(", ")}: texts from it are held unless they carry the deal code`] : []),
    ...(d.settings && !d.settings.default_area ? ["no default area: every request must say where (workspace-create --area, or the agent passes area)"] : []),
    ...(d.settings && !d.settings.approver_email ? ["no approver email: receipts go by text only"] : []),
  ];
  return { ready: checks.every((c) => c.pass), checks, warnings };
}

/** `show`: the workspace's settings, credential state, vendors, the suppressions that affect them and the readiness check. Never prints a secret or hash. */
export function showText(d: ShowData): string {
  const w = d.workspace;
  const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
  const sup = new Map(d.suppressions.map((s) => [s.contact, s]));
  return [
    `Workspace ${w.id} (${w.name}), timezone ${w.timezone}, created ${w.created_at}`,
    `  Credentials: ${w.revoked_at ? `REVOKED ${w.revoked_at} (run rotate to issue new ones)` : `bearer token ${w.token_hash ? "set" : "none"}, connector URL ${w.connector_secret_hash ? "set" : "none"}`}`,
    d.settings
      ? `  Approver: phone ${d.settings.approver_phone ?? "none (live approvals need one)"} / email ${d.settings.approver_email ?? "none"}; spending cap ${usd(d.settings.spending_cap_cents)} per payment; default area ${d.settings.default_area ?? "none"}`
      : "  Settings: none (set-approver and set-cap)",
    ...(d.sharedApprover.length ? [`  WARNING: the approver phone also approves for ${d.sharedApprover.join(", ")}; texts from it are held unless they carry the deal code.`] : []),
    `  Vendors (${d.vendors.length}):`,
    ...(d.vendors.length ? d.vendors.map((v) => { const s = sup.get(v.contact); return `    ${v.name} <${mask(v.contact)}> by ${v.channel ?? (v.contact.includes("@") ? "email" : "phone")}; consent: ${v.consent}; added ${v.created_at} by ${v.added_by}${s ? `; SUPPRESSED (${s.reason} ${s.created_at}): never contacted` : ""}`; }) : ["    none: deals can reach only the server allowlist (add-vendor)"]),
    "",
    ...readinessText(readiness(d)),
  ].join("\n");
}

export function readinessText(r: ReturnType<typeof readiness>): string[] {
  return [
    `  Readiness: ${r.ready ? "PASS" : "FAIL"} (${r.checks.filter((c) => c.pass).length}/${r.checks.length} checks)`,
    ...r.checks.map((c) => `    [${c.pass ? "PASS" : "FAIL"}] ${c.name}: ${c.detail}${c.fix ? `. Fix: ${c.fix}` : ""}`),
    ...r.warnings.map((w) => `    [WARN] ${w}`),
  ];
}

/** The repository calls the operator commands need (PostgresRepository in production; the in-memory one in tests). */
export type AdminRepo = Pick<Repository, "getWorkspace" | "getSettings" | "saveSettings" | "listWorkspaceVendors" | "findSuppressions" | "listWorkspacesByApproverPhone" | "setWorkspaceCredentials" | "addWorkspaceVendor" | "removeWorkspaceVendor" | "removeSuppression">;

/** Gather what `show` prints (and the readiness check reads). */
export async function showData(repo: AdminRepo, id: string): Promise<ShowData> {
  const workspace = await repo.getWorkspace(id);
  if (!workspace) throw new Error(`no workspace ${id}`);
  const [settings, vendors] = await Promise.all([repo.getSettings(id), repo.listWorkspaceVendors(id)]);
  const suppressions = await repo.findSuppressions(vendors.map((v) => v.contact));
  const sharedApprover = settings?.approver_phone ? (await repo.listWorkspacesByApproverPhone(settings.approver_phone)).filter((w) => w !== id) : [];
  return { workspace, settings, vendors, suppressions, sharedApprover };
}

/** Run one operator command against a repository; returns what to print and whether it failed (show: readiness FAIL). */
export async function runAdmin(cmd: AdminCommand, repo: AdminRepo): Promise<{ text: string; failed: boolean }> {
  if (cmd.kind === "remove-suppression") {
    const r = await repo.removeSuppression(cmd.contact, cmd.by, cmd.why);
    return { failed: false, text: r ? `${cmd.contact}: ${r.reason} suppression from ${r.suppressed_at} removed by ${r.removed_by} (${r.why}). Haggle may contact it again, only from workspaces that authorize it.` : `${cmd.contact} wasn't suppressed; nothing changed.` };
  }
  const ws = await repo.getWorkspace(cmd.id);
  if (!ws) throw new Error(`no workspace ${cmd.id}`);
  if (cmd.kind === "show") {
    const d = await showData(repo, cmd.id);
    return { text: showText(d), failed: !readiness(d).ready };
  }
  if (cmd.kind === "revoke") {
    await repo.setWorkspaceCredentials(cmd.id, { revoked: true });
    return { failed: false, text: `Workspace ${cmd.id} revoked: its bearer token and connector URL no longer work. Run rotate to issue new ones.` };
  }
  if (cmd.kind === "rotate") {
    const token = newSecret("hgw");
    const secret = newSecret("hgc");
    await repo.setWorkspaceCredentials(cmd.id, { token_hash: hashSecret(token), connector_secret_hash: hashSecret(secret), revoked: false });
    return { failed: false, text: [`Workspace ${cmd.id}: new credentials (the old ones no longer work). Save these now; they can't be shown again.`, "", ...connectionLines(cmd.baseUrl, token, secret)].join("\n") };
  }
  if (cmd.kind === "add-vendor") {
    await repo.addWorkspaceVendor({ workspace_id: cmd.id, contact: cmd.contact, name: cmd.name, consent: cmd.consent, added_by: "operator (workspace-admin)", ...(cmd.channel ? { channel: cmd.channel } : {}) });
    const [s] = await repo.findSuppressions([cmd.contact]);
    return { failed: false, text: `Workspace ${cmd.id}: ${cmd.name} <${cmd.contact}> authorized${cmd.channel ? ` by ${cmd.channel === "imessage" ? "text" : cmd.channel}` : ""} (consent: ${cmd.consent}). Agents name it: deal(businesses=['${cmd.name}']), or omit businesses to contact every vendor of this workspace.${s ? ` Note: this contact is suppressed (${s.reason}); Haggle still won't contact it (remove-suppression if that was wrong).` : ""}` };
  }
  if (cmd.kind === "remove-vendor") return { failed: false, text: (await repo.removeWorkspaceVendor(cmd.id, cmd.contact)) ? `Workspace ${cmd.id}: ${cmd.contact} no longer authorized.` : `Workspace ${cmd.id}: ${cmd.contact} wasn't authorized.` };
  if (cmd.kind === "list-vendors") {
    const list = await repo.listWorkspaceVendors(cmd.id);
    return { failed: false, text: list.length ? list.map((v) => `${v.name} <${v.contact}>${v.channel ? ` by ${v.channel}` : ""} · consent: ${v.consent} · added ${v.created_at}`).join("\n") : `Workspace ${cmd.id}: no vendors authorized.` };
  }
  const cur = await repo.getSettings(cmd.id);
  if (!cur) throw new Error(`workspace ${cmd.id} has no settings row`);
  const { updated_at: _u, ...row } = cur;
  if (cmd.kind === "set-approver" && cmd.phone) {
    const problem = sharedApproverProblem(cmd.phone, cmd.id, await repo.listWorkspacesByApproverPhone(cmd.phone), cmd.allowShared);
    if (problem) throw new Error(problem);
  }
  const next = cmd.kind === "set-cap" ? { ...row, spending_cap_cents: cmd.capCents }
    : { ...row, ...(cmd.phone !== undefined ? { approver_phone: cmd.phone } : {}), ...(cmd.email !== undefined ? { approver_email: cmd.email } : {}) };
  await repo.saveSettings(next, cmd.id);
  return { failed: false, text: cmd.kind === "set-cap" ? `Workspace ${cmd.id}: spending cap $${(cmd.capCents / 100).toFixed(2)} per payment (the server ceiling still applies).` : `Workspace ${cmd.id}: approver ${next.approver_phone ?? "no phone"} / ${next.approver_email ?? "no email"}.` };
}

/**
 * The exact client connection details, printed once with fresh credentials (only hashes are stored).
 * The bearer token and the connector URL are both exercised over HTTP by this repo's tests; whether a
 * given hosted client accepts an authless custom connector is that client's policy (docs/pilot-onboarding.md).
 */
export function connectionLines(baseUrl: string, token: string, secret: string): string[] {
  const base = baseUrl.replace(/\/+$/, "");
  return [
    `  MCP endpoint:   ${base}/mcp`,
    `  Bearer token:   ${token}`,
    `  Connector URL:  ${base}/c/${secret}/mcp`,
    "",
    `  Claude Code:    claude mcp add --transport http haggle ${base}/mcp --header "Authorization: Bearer ${token}"`,
    "  Any MCP client that can send a header: the MCP endpoint plus Authorization: Bearer <token>.",
    "  Clients that only take a URL (Claude or ChatGPT custom connectors): the connector URL. Treat it like a password.",
  ];
}

async function main(argv = process.argv.slice(2)) {
  const cmd = planAdmin(argv);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set (the engine database)");
  const schema = process.env.HAGGLE_DB_SCHEMA?.trim();
  const repo = new PostgresRepository(url, { max: 1, ...(schema ? { schema } : {}) });
  try {
    const r = await runAdmin(cmd, repo);
    console.log(r.text);
    if (r.failed) process.exitCode = 1;
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
