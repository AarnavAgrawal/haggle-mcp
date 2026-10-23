// The Terms version a user accepts at onboarding (web_profiles.terms_version) and the contact address
// shown on the legal pages and footer. Bump TERMS_VERSION whenever /terms or /acceptable-use change.

export const TERMS_VERSION = "2026-10-22-draft";

/** NEXT_PUBLIC_SUPPORT_EMAIL (inlined at build time); null when unset (the footer then omits it). */
export const supportEmail = (): string | null => process.env.NEXT_PUBLIC_SUPPORT_EMAIL?.trim() || null;

/** "Draft" banner text on every legal page until counsel signs off. */
export const LEGAL_DRAFT_NOTE = "Draft: to be reviewed by counsel before launch.";
