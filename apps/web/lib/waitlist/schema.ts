// What the waitlist form takes. One set of rules for the form (errors next to each field) and for
// POST /api/waitlist (the check that counts); the limits match the checks in migration 303.
// Plain code on purpose: this runs in the browser, and zod probes `new Function` there, which the site's CSP blocks.

export interface WaitlistRow {
  email: string;
  full_name: string;
  organization: string;
  use_case: string | null;
}
export type WaitlistField = keyof WaitlistRow;
export type WaitlistErrors = Partial<Record<WaitlistField, string>>;

// Printable ASCII only: JS and Postgres lowercase some other letters differently, and the table checks email = lower(email).
const EMAIL = /^[!-?A-~]+@[!-?A-~]+\.[!-?A-~]+$/;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The row to store, or what's wrong with each field (in the form's order). */
export function parseJoin(input: Record<string, unknown>): { ok: true; row: WaitlistRow } | { ok: false; errors: WaitlistErrors } {
  const email = text(input.email).toLowerCase();
  const full_name = text(input.full_name);
  const organization = text(input.organization);
  const use_case = text(input.use_case);

  const errors: WaitlistErrors = {};
  if (!email) errors.email = "Enter your email.";
  else if (email.length > 254) errors.email = "That email is too long.";
  else if (!EMAIL.test(email)) errors.email = "Enter a valid email address.";
  if (!full_name) errors.full_name = "Enter your full name.";
  else if (full_name.length > 120) errors.full_name = "Keep your name under 120 characters.";
  if (!organization) errors.organization = "Enter your company, organization or school.";
  else if (organization.length > 160) errors.organization = "Keep this under 160 characters.";
  if (use_case.length > 500) errors.use_case = "Keep this under 500 characters.";

  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, row: { email, full_name, organization, use_case: use_case || null } };
}
