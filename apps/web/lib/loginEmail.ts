/** Accounts given a username (not a real mailbox) sign in as <username>@ this domain; nothing is ever sent there. */
export const USERNAME_DOMAIN = "users.tryhaggle.tech";

/**
 * The Supabase sign-in email for what the person typed: an email as is, a username ("ycombinator") as
 * ycombinator@users.tryhaggle.tech. Null when it's neither. Pure.
 */
export function loginEmail(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (v.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
  return /^[a-z0-9][a-z0-9._-]{1,62}$/.test(v) ? `${v}@${USERNAME_DOMAIN}` : null;
}
