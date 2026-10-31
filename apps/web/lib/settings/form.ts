// The settings form, checked in the browser and again by /api/settings before anything is sent. Pure.
// Only the fields present are checked and sent; "" clears an optional one. The MCP server checks
// everything again (the ceiling, the time zone, E.164).

/** What the MCP server's settings route accepts (POST /internal/workspaces/settings). */
export interface SettingsPatch {
  name?: string;
  timezone?: string;
  sender_name?: string | null;
  default_area?: string | null;
  approver_email?: string | null;
  approver_phone?: string | null;
  default_deal_limit_usd?: number;
}
export type SettingsField = keyof SettingsPatch;
export const SETTINGS_FIELDS: readonly SettingsField[] = ["name", "timezone", "sender_name", "default_area", "approver_email", "approver_phone", "default_deal_limit_usd"];

export type FormResult = { ok: true; value: SettingsPatch } | { ok: false; errors: Partial<Record<SettingsField, string>> };

const text = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim() : v === null ? "" : undefined);

/** A US number typed loosely ("(415) 555-0123") becomes +14155550123; anything else must already be E.164. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[\s().-]/g, "");
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  return digits;
}

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateSettingsForm(raw: Record<string, unknown>): FormResult {
  const errors: Partial<Record<SettingsField, string>> = {};
  const value: SettingsPatch = {};
  for (const k of Object.keys(raw)) if (!(SETTINGS_FIELDS as readonly string[]).includes(k)) return { ok: false, errors: {} };

  const name = text(raw.name);
  if (name !== undefined) {
    if (!name) errors.name = "Enter a name.";
    else if (name.length > 120) errors.name = "Use at most 120 characters.";
    else value.name = name;
  }
  const tz = text(raw.timezone);
  if (tz !== undefined) {
    if (!tz || tz.length > 64 || !validTimezone(tz)) errors.timezone = "Use a time zone like America/Los_Angeles.";
    else value.timezone = tz;
  }
  const sender = text(raw.sender_name);
  if (sender !== undefined) {
    if (sender.length > 80) errors.sender_name = "Use at most 80 characters.";
    else value.sender_name = sender || null;
  }
  const area = text(raw.default_area);
  if (area !== undefined) {
    if (area && (area.length < 2 || area.length > 200)) errors.default_area = "Use 2 to 200 characters, e.g. Oakland, CA.";
    else value.default_area = area || null;
  }
  const email = text(raw.approver_email);
  if (email !== undefined) {
    const e = email.toLowerCase();
    if (e && (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) errors.approver_email = "Enter an email address.";
    else value.approver_email = e || null;
  }
  const phone = text(raw.approver_phone);
  if (phone !== undefined) {
    const p = phone ? normalizePhone(phone) : "";
    if (p && !/^\+[1-9]\d{6,14}$/.test(p)) errors.approver_phone = "Enter a phone number with its country code, e.g. +1 415 555 0123.";
    else value.approver_phone = p || null;
  }
  const limit = raw.default_deal_limit_usd;
  if (limit !== undefined) {
    const n = typeof limit === "number" ? limit : typeof limit === "string" ? Number(limit.replace(/[$,\s]/g, "")) : NaN;
    if (!Number.isFinite(n) || n <= 0) errors.default_deal_limit_usd = "Enter an amount above $0.";
    else if (n > 1_000_000) errors.default_deal_limit_usd = "Enter at most $1,000,000.";
    else value.default_deal_limit_usd = Math.round(n * 100) / 100;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, value };
}
