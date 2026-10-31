// The "Add vendor" form's rules, shared by the browser (inline errors) and /api/vendors (the check
// that counts). The MCP server enforces the same consent rules again (apps/mcp/src/service/vendors.ts):
// a business found only in a public listing may be emailed, never called or texted.

export type VendorChannel = "email" | "phone" | "imessage";
export type ConsentBasis = "existing_relationship" | "business_agreed" | "public_listing_email";

/** The consent choices, in plain words, strongest first. */
export const CONSENT_OPTIONS: { value: ConsentBasis; label: string; explain: string; channels: VendorChannel[] }[] = [
  { value: "existing_relationship", label: "We already work with them", explain: "You have bought from or worked with this business before, and it expects to hear from you this way.", channels: ["email", "phone", "imessage"] },
  { value: "business_agreed", label: "They agreed to be contacted", explain: "Someone at the business told you Haggle (an AI assistant acting for you) may contact them this way.", channels: ["email", "phone", "imessage"] },
  { value: "public_listing_email", label: "Public listing (email only)", explain: "You found the business's email on its website or listing. Haggle may email it, but never calls or texts a business on this basis.", channels: ["email"] },
];

export const CHANNEL_OPTIONS: { value: VendorChannel; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone call (Voice AI)" },
  { value: "imessage", label: "Text message" },
];

export const ATTESTATION = "I confirm this business agreed to be contacted this way, or I have an existing relationship with it.";

export interface VendorFormInput {
  name?: unknown;
  contact?: unknown;
  channel?: unknown;
  consent_basis?: unknown;
  note?: unknown;
  attested?: unknown;
  /** The public listing it was found in ("aws:…" / "place:…"): the server stores its opening hours. */
  business_ref?: unknown;
}
/** What /api/vendors sends on to the MCP server (POST /internal/vendors). */
export interface AddVendorBody {
  name: string;
  contact: string;
  channel: VendorChannel;
  consent_basis: ConsentBasis;
  note?: string;
  business_ref?: string;
}
export type FormField = "name" | "contact" | "channel" | "consent_basis" | "note" | "attested";
export type FormResult = { ok: true; value: AddVendorBody } | { ok: false; errors: Partial<Record<FormField, string>> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const plain = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * An email lowercased, or a phone number in E.164. A 10-digit number (or 11 starting with 1) is read
 * as a US/Canada number; anything else needs its +country code. Null when it is neither.
 */
export function normalizeContact(raw: string): { kind: "email" | "phone"; value: string } | null {
  const s = raw.trim();
  if (s.includes("@")) return EMAIL.test(s.toLowerCase()) ? { kind: "email", value: s.toLowerCase() } : null;
  if (/[^\d\s().+-]/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  const value = s.startsWith("+") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : "";
  return E164.test(value) ? { kind: "phone", value } : null;
}

/** Can this consent basis support this channel? */
export const basisAllows = (basis: ConsentBasis, channel: VendorChannel) => CONSENT_OPTIONS.find((o) => o.value === basis)!.channels.includes(channel);

export function validateVendorForm(i: VendorFormInput): FormResult {
  const errors: Partial<Record<FormField, string>> = {};
  const name = plain(str(i.name));
  if (!name) errors.name = "Enter the business's name.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";

  const contact = normalizeContact(str(i.contact));
  if (!str(i.contact).trim()) errors.contact = "Enter the business's email or phone number.";
  else if (!contact) errors.contact = "Enter an email address, or a phone number with its country code (+1 415 555 0123).";

  const rawChannel = str(i.channel);
  let channel: VendorChannel | null = rawChannel === "email" || rawChannel === "phone" || rawChannel === "imessage" ? rawChannel : null;
  if (rawChannel && !channel) errors.channel = "Choose email, a phone call or a text.";
  if (contact && !channel) channel = contact.kind === "email" ? "email" : "phone";
  if (contact && channel && (channel === "email") !== (contact.kind === "email")) {
    errors.channel = contact.kind === "email" ? "An email address is reached by email." : "A phone number is reached by a call or a text.";
  }

  const basis = CONSENT_OPTIONS.find((o) => o.value === i.consent_basis)?.value ?? null;
  if (!basis) errors.consent_basis = "Choose how this business agreed to be contacted.";
  else if (channel && !errors.channel && !basisAllows(basis, channel)) {
    errors.consent_basis = "A business found only in a public listing can be emailed, never called or texted. Add its email, or choose a stronger basis if it is true.";
  }

  const note = plain(str(i.note));
  if (note.length > 300) errors.note = "Keep the note under 300 characters.";
  if (i.attested !== true) errors.attested = "Confirm that this business agreed to be contacted, or that you already work with it.";

  if (Object.keys(errors).length || !contact || !channel || !basis) return { ok: false, errors };
  // Only a listing ref Find businesses returned; anything else is dropped (it only ever adds opening hours).
  const ref = str(i.business_ref).trim();
  const businessRef = /^(aws|place):[A-Za-z0-9_=+/-]{3,515}$/.test(ref) ? ref : undefined;
  return { ok: true, value: { name, contact: contact.value, channel, consent_basis: basis, ...(note ? { note } : {}), ...(businessRef ? { business_ref: businessRef } : {}) } };
}
