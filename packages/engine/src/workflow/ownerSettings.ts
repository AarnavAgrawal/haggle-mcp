// The signed-in workspace owner's settings (web app, POST /internal/workspaces/settings; migration 129).
// Pure helpers: input checks, the audit rows a change writes, and the codes and messages that verify a
// new approver. HaggleEngine (updateSettings, ownerUpdateSettings, confirmApproverChange) does the I/O.
//
// Who may change what:
//   operator (scripts)  everything, up to the server ceiling
//   owner (web app)     everything, up to the server ceiling; a NEW approver phone or email waits for
//                       verification (a 6-digit code by iMessage, or a confirm link by email), so a
//                       stolen session can't quietly redirect approvals; the old approver stays until then
//   agent (MCP tools)   lower the cap and set the area; never the approver, never a higher cap
import { createHash, randomBytes } from "node:crypto";
import { validTimezone } from "../reputation/hours.ts";
import type { ApproverChangeRow, SettingsActor, SettingsAuditRow, SettingsRow, WorkspaceProfilePatch } from "../store/types.ts";
import { callbackCodeHash, codeMatches, newCallbackCode } from "./callbackAuth.ts";

/** How long a texted code stays valid. */
export const APPROVER_PHONE_TTL_MS = 15 * 60_000;
/** How long an emailed confirm link stays valid. */
export const APPROVER_EMAIL_TTL_MS = 24 * 60 * 60_000;
/** Wrong codes before a pending change fails (then it must be requested again). */
export const MAX_APPROVER_CODE_ATTEMPTS = 5;

export type Problem = { code: string; message: string; fix: string };

/** What the owner's settings page shows. Approver contacts are masked; pending changes too. */
export interface WorkspaceSettingsView {
  name: string;
  timezone: string;
  sender_name: string | null;
  default_area: string | null;
  /** The default limit for new deals (settings.spending_cap_cents, in USD). */
  default_deal_limit_usd: number;
  /** The server's ceiling: no limit can be set above it. */
  ceiling_usd: number;
  approver: { phone: string | null; email: string | null };
  pending: { kind: "phone" | "email"; to: string; expires_at: string; attempts_left: number }[];
}

/** The owner's request, already in engine units (cents). Absent = unchanged; null clears. */
export interface OwnerSettingsPatch {
  name?: string;
  timezone?: string;
  sender_name?: string | null;
  default_area?: string | null;
  /** The default limit for new deals (stored as settings.spending_cap_cents). */
  spending_cap_cents?: number;
  approver_phone?: string | null;
  approver_email?: string | null;
}

const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** The workspace's own fields from an owner's patch, checked; or the first problem. */
export function profilePatch(p: OwnerSettingsPatch): { patch: WorkspaceProfilePatch } | { problem: Problem } {
  const out: WorkspaceProfilePatch = {};
  if (p.name !== undefined) {
    const n = plain(p.name);
    if (n.length < 1 || n.length > 120) return { problem: { code: "bad_name", message: "The workspace name must be 1 to 120 characters.", fix: "Enter a shorter name." } };
    out.name = n;
  }
  if (p.timezone !== undefined) {
    if (!validTimezone(p.timezone)) return { problem: { code: "bad_timezone", message: `${String(p.timezone).slice(0, 64)} isn't a time zone.`, fix: "Use an IANA time zone, e.g. America/Los_Angeles." } };
    out.timezone = p.timezone;
  }
  if (p.sender_name !== undefined) {
    const n = p.sender_name === null ? "" : plain(p.sender_name);
    if (n.length > 80) return { problem: { code: "bad_sender_name", message: "The sender name must be at most 80 characters.", fix: "Enter a shorter name, e.g. Priya at Acme Labs." } };
    out.sender_name = n || null;
  }
  return { patch: out };
}

const show = (field: string, v: unknown, mask: (h: string) => string): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const s = String(v);
  return (field === "approver_phone" || field === "approver_email" ? mask(s) : s).slice(0, 300);
};

/** One audit row per field whose value changed (phones and emails masked). */
export function auditRows(
  workspaceId: string, by: SettingsActor, actor: string | null,
  before: Record<string, unknown>, after: Record<string, unknown>, mask: (h: string) => string,
): Omit<SettingsAuditRow, "at">[] {
  const rows: Omit<SettingsAuditRow, "at">[] = [];
  for (const field of Object.keys(after)) {
    if (field === "updated_at" || after[field] === undefined) continue;
    if ((before[field] ?? null) === (after[field] ?? null)) continue;
    rows.push({ workspace_id: workspaceId, by, actor: actor ? actor.slice(0, 200) : null, field, old_value: show(field, before[field], mask), new_value: show(field, after[field], mask) });
  }
  return rows;
}

/** The settings fields an owner may change directly (approver fields only to clear them). */
export function settingsPatch(p: OwnerSettingsPatch): Partial<Omit<SettingsRow, "updated_at">> {
  return {
    ...(p.default_area !== undefined ? { default_area: p.default_area === null ? null : plain(p.default_area) || null } : {}),
    ...(p.spending_cap_cents !== undefined ? { spending_cap_cents: p.spending_cap_cents } : {}),
    ...(p.approver_phone === null ? { approver_phone: null } : {}),
    ...(p.approver_email === null ? { approver_email: null } : {}),
  };
}

/** A new code (6 digits) and, for an email, a confirm-link token; only their hashes are stored. */
export function newVerification(id: string, kind: "phone" | "email"): { code: string; codeHash: string; token: string | null; tokenHash: string | null } {
  const code = newCallbackCode();
  const token = kind === "email" ? randomBytes(32).toString("base64url") : null;
  return { code, codeHash: callbackCodeHash(id, code), token, tokenHash: token ? tokenHash(token) : null };
}

export const tokenHash = (token: string): string => createHash("sha256").update(`approver-link:${token}`, "utf8").digest("hex");

/** Does this typed code match the pending change? Timing-safe; spaces and dashes ignored. */
export function approverCodeMatches(row: Pick<ApproverChangeRow, "id" | "code_hash">, typed: string): boolean {
  const code = typed.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(code) && codeMatches(row.id, code, row.code_hash);
}

export const isExpired = (row: Pick<ApproverChangeRow, "expires_at">, now: Date): boolean => Date.parse(row.expires_at) <= now.getTime();

/** The iMessage that carries the code: under 159 characters, no link, no phone number. */
export function approverCodeText(code: string): string {
  return `Haggle code ${code}. Enter it in Settings to make this number your approver. Didn't ask? Ignore this text.`;
}

/** The confirm email: the link (when the web app gave its URL) and the code, which also works typed in. */
export function approverConfirmEmail(a: { code: string; token: string; confirmUrl?: string | null; workspaceName: string; minutes: number }): { subject: string; bodyText: string } {
  const link = a.confirmUrl ? `${a.confirmUrl}${a.confirmUrl.includes("?") ? "&" : "?"}confirm=${encodeURIComponent(a.token)}` : null;
  return {
    subject: "Confirm your Haggle approver email",
    bodyText: [
      `Someone signed in to the Haggle workspace "${a.workspaceName}" asked to send purchase approvals to this address.`,
      "",
      ...(link ? ["To confirm, open this link while signed in to Haggle:", link, "", `Or enter this code in Settings: ${a.code}`] : [`To confirm, enter this code in Settings: ${a.code}`]),
      "",
      `It expires in ${Math.round(a.minutes / 60)} hours. Didn't ask? Ignore this email; nothing changes.`,
    ].join("\n"),
  };
}

/** The notice to the current approver's email that a change was asked for (so it is never quiet). */
export function approverChangeNotice(a: { kind: "phone" | "email"; to: string; workspaceName: string }): { subject: string; bodyText: string } {
  return {
    subject: "Your Haggle approver is being changed",
    bodyText: [
      `Someone signed in to the Haggle workspace "${a.workspaceName}" asked to change the approver ${a.kind} to ${a.to}.`,
      "Nothing changes until the new contact confirms it. If this wasn't you, sign in to Haggle, check Settings and change your password.",
    ].join("\n"),
  };
}
