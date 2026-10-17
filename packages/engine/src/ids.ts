import { createHash, randomInt, randomUUID } from "node:crypto";

/** Deterministic business id from the normalised contact email (contract D5). */
export function businessIdFor(email: string): string {
  return `biz_${createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 16)}`;
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
