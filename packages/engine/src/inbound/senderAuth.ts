// PURE: identity checks for mail and texts from outside Inkbox (real vendors on Gmail, Outlook,
// their own domains), plus opt-out and bounce recognition. Inkbox authenticates only its own
// identities and exposes no SPF/DKIM/DMARC results for other mail, so a From address and a thread
// are never proof. A reply counts as the pinned business only with all of:
//   1. From = the address Haggle wrote to (the snapshot on the job);
//   2. In-Reply-To/References naming one of Haggle's own outbound Message-IDs to that business;
//   3. the business's reply token (an HMAC of job + business under a server secret, sent only to
//      that address in the subject and body of every email to it), quoted back in the reply;
//   4. no authentication failure in whatever evidence the provider does give (DMARC/SPF fail).
// When a provider supplies an aligned DMARC pass (or aligned DKIM) for the pinned domain, that
// stands in for the token. Anything else is quarantined: "identity_unverified".
import { createHmac } from "node:crypto";
import type { AuthEvidence } from "./primitive.ts";
import { normalizeAddress, normalizeMessageId } from "./matching.ts";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L

/** "HGR-7KQ2M9XA4T": 10 characters (~49 bits) from HMAC-SHA256(secret, job:business). */
export function replyToken(secret: string, jobId: string, businessId: string): string {
  const mac = createHmac("sha256", secret).update(`${jobId}:${businessId}`, "utf8").digest();
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[mac[i]! % ALPHABET.length];
  return `HGR-${out}`;
}

const domainOf = (address: string) => normalizeAddress(address).split("@")[1] ?? "";

/** Evidence the provider gave that this mail is NOT from its From domain. */
export function authFailed(e: AuthEvidence): boolean {
  return /^(fail|permerror)$/i.test(e.dmarc ?? "") || /^fail$/i.test(e.spf ?? "");
}

/** Aligned DMARC pass (or aligned DKIM) for the pinned address's domain. */
export function authPassedFor(e: AuthEvidence, pinned: string): boolean {
  const d = domainOf(pinned);
  if (!d) return false;
  return (/^pass$/i.test(e.dmarc ?? "") && (e.dmarcFromDomain ?? "").toLowerCase() === d) || e.alignedDkimDomains.some((x) => x.toLowerCase() === d);
}

export type ExternalReplyVerdict = { ok: true; reason: "external-reply-token" | "external-dmarc-aligned" } | { ok: false; reason: "identity_unverified"; detail: string };

export function verifyExternalReply(i: {
  from: string; pinned: string; inReplyTo: string[]; references: string[]; ourMessageIds: (string | null)[];
  subject: string | null; bodyText: string | null; token: string; evidence: AuthEvidence;
}): ExternalReplyVerdict {
  const no = (detail: string): ExternalReplyVerdict => ({ ok: false, reason: "identity_unverified", detail });
  if (normalizeAddress(i.from) !== normalizeAddress(i.pinned)) return no("from_mismatch");
  if (authFailed(i.evidence)) return no("auth_failed");
  const ours = new Set(i.ourMessageIds.filter((x): x is string => !!x).map(normalizeMessageId));
  const inThread = [...i.inReplyTo, ...i.references].some((x) => ours.has(normalizeMessageId(x)));
  if (!inThread) return no("not_in_our_thread");
  if (authPassedFor(i.evidence, i.pinned)) return { ok: true, reason: "external-dmarc-aligned" };
  const hay = `${i.subject ?? ""}\n${i.bodyText ?? ""}`.toUpperCase();
  if (!hay.includes(i.token.toUpperCase())) return no("token_missing");
  return { ok: true, reason: "external-reply-token" };
}

/**
 * An explicit request not to be contacted, in the business's own first lines (quoted history and
 * signatures ignored): STOP, unsubscribe, remove me, do not contact/email, opt out.
 */
export function isOptOut(text: string | null): boolean {
  const own = (text ?? "").split(/\n\s*(?:On .{0,200}wrote:|-{2,}\s*Original Message|From: )/i)[0]!.split("\n").filter((l) => !/^\s*>/.test(l)).join(" ").trim();
  if (!own || own.length > 400) return false;
  // Whole-message commands, or unmistakable requests; "don't contact us before Monday" is not one.
  return /^\s*(stop|stop all|unsubscribe|opt[ -]?out|remove me|remove)\s*[.!]*\s*$/i.test(own)
    || /\bunsubscribe\b/i.test(own)
    || /\b(remove (me|us) from (your|this) (mailing )?list|opt (me|us) out)\b/i.test(own)
    || /\b(do not|don'?t|please stop|stop) (contact|email|text|call|messag)(ing|e)? (me|us)\b\s*(again|anymore|any more|ever)?\s*([.!]|$)/i.test(own);
}

const BOUNCE_FROM = /^(mailer-daemon|postmaster|mail-daemon|bounce[s]?)@/i;
const BOUNCE_SUBJECT = /(delivery status notification|undeliverable|undelivered mail|mail delivery (failed|subsystem)|returned mail|delivery (has )?failed|failure notice)/i;

/**
 * A delivery failure report. `messageIds` are the Message-IDs it quotes (a bounce counts for a job
 * only when it names one of Haggle's own outbound messages); `hard` = a permanent 5.x.x failure.
 */
export function parseBounce(m: { from: string | null; subject: string | null; bodyText: string | null; inReplyTo: string[]; references: string[] }): { hard: boolean; messageIds: string[]; text: string } | null {
  if (!(m.from && BOUNCE_FROM.test(m.from)) && !BOUNCE_SUBJECT.test(m.subject ?? "")) return null;
  const text = m.bodyText ?? "";
  const ids = [...m.inReplyTo, ...m.references, ...[...text.matchAll(/<[^<>\s@]+@[^<>\s]+>/g)].map((x) => x[0])];
  const hard = /\b5\.\d{1,3}\.\d{1,3}\b|\b55[0-4]\b/.test(text) && !/\b4\.\d{1,3}\.\d{1,3}\b/.test(text.split(/\b5\.\d/)[0] ?? "");
  return { hard, messageIds: [...new Set(ids)], text: text.slice(0, 500) };
}
