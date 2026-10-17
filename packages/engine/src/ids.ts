import { createHash, randomInt, randomUUID } from "node:crypto";

/** Deterministic business id from the normalised contact email (contract D5). */
export function businessIdFor(email: string): string {
  return `biz_${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
}

/**
 * v5: a business may have no email (phone-only). Email keeps the D5 id; otherwise the id hashes
 * the E.164 number ("tel:+1415...") or the Agent Card URL, so it is still deterministic.
 */
export function businessIdForContact(c: { email?: string | null; phone?: string | null; a2a_card_url?: string | null }): string {
  if (c.email) return businessIdFor(c.email);
  if (c.phone) return businessIdFor(`tel:${c.phone.trim()}`);
  if (c.a2a_card_url) return businessIdFor(`a2a:${c.a2a_card_url.trim()}`);
  throw new Error("business has no contact");
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

// No 0/O/1/I so codes read cleanly in an address and a subject line.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newShortCode(length = 4): string {
  return Array.from({ length }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
}

/** 4-digit approval code (quote-broker's verifyApproval expects \d{4}). */
export function newApprovalCode(): string {
  return String(randomInt(1000, 10000));
}

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "business";
}
