// Operator review of quarantined inbound email (apps/mcp/scripts/quarantine.ts): list, show a
// redacted preview, release after independent verification, or reject. Works on the repository
// alone (the operator script has database access, no providers); the running server's next advance
// reads a released message like any other reply.
//
// Release is deliberately narrow:
//   * the operator must say who they are and how they verified it on an independent channel
//     ("phoned the vendor at the number on its website"); recorded append-only with the original
//     quarantine reason (quarantine_resolutions, migration 112), one decision per message;
//   * the message becomes a business reply with trust_reason "operator_verified", which is
//     continuity-only (inbound/trustStrength.ts): it can produce a quote the human then approves out
//     of band, but never approves, pays, names a payee, confirms a booking or marks money received;
//   * it is read only by the quote parser (never the booking/payment-instructions path), and only
//     while the deal is still collecting or deciding;
//   * likely forgeries (an authentication failure) and delivery reports are never releasable;
//   * a message is never moved to another deal or business than the one it was matched to; one
//     that matched nothing needs the operator to name both, and that business's address on file.
// Reject records the decision and changes nothing else.
import { newId } from "../ids.ts";
import type { MessageRow, QuarantineResolutionRow, Repository } from "../store/types.ts";
import { cleanEmailBody } from "./emailBody.ts";
import { normalizeAddress } from "./matching.ts";
import { explainQuarantine } from "./quarantineReasons.ts";

export const OPERATOR_VERIFIED = "operator_verified";

/** Never releasable: likely spoofed, or not a message from anyone (a delivery report). */
const NOT_RELEASABLE = new Set(["identity_unverified:auth_failed", "bounce", "bounce_soft", "bounce_unmatched"]);
/** A release can still change the outcome only while quotes are being collected or decided on. */
const RELEASABLE_STATES = new Set(["contacting", "collecting", "negotiating", "awaiting_approval"]);

type Repo = Pick<Repository, "getMessage" | "getJob" | "getBusinesses" | "findSuppressions" | "insertQuarantineResolution" | "listQuarantineResolutions" | "listQuarantinedMessages" | "updateMessage" | "updateBusiness" | "appendEvent" | "touchJob">;

export type ResolveRefusal = { ok: false; code: "not_found" | "not_quarantined" | "already_resolved" | "not_releasable" | "needs_target" | "wrong_target" | "job_not_open" | "unknown_business" | "suppressed" | "bad_input"; reason: string };
export type ReleaseResult = { ok: true; jobId: string; businessId: string; messageId: string; resolution: QuarantineResolutionRow } | ResolveRefusal;
export type RejectResult = { ok: true; jobId: string | null; messageId: string; resolution: QuarantineResolutionRow } | ResolveRefusal;

const no = (code: ResolveRefusal["code"], reason: string): ResolveRefusal => ({ ok: false, code, reason });

/** Held for review: stored as quarantine, or a reply that was stored untrusted (never read). */
export function isQuarantined(m: Pick<MessageRow, "direction" | "kind" | "sender_trusted">): boolean {
  return m.direction === "in" && (m.kind === "quarantine" || (m.kind === "reply" && m.sender_trusted !== true));
}

/** The reason it was held: the quarantine reason, else the trust verdict's reason. */
export function heldReason(m: Pick<MessageRow, "quarantine_reason" | "trust_reason">): string {
  return (m.quarantine_reason ?? m.trust_reason ?? "unverified").slice(0, 200);
}

function checkActor(by: string, text: string, what: string): ResolveRefusal | null {
  if (by.trim().length < 2 || by.trim().length > 80) return no("bad_input", "--verified-by / --by is required: who is deciding (2-80 characters)");
  if (text.trim().length < 10 || text.trim().length > 500) return no("bad_input", `${what} is required (10-500 characters)`);
  return null;
}

/**
 * Release a held message as the business's reply. `jobId`/`businessId` are needed only for a message
 * that matched no deal; for one that did they must match (or be omitted).
 */
export async function releaseQuarantined(repo: Repo, i: { messageId: string; verifiedBy: string; how: string; jobId?: string; businessId?: string; now?: Date }): Promise<ReleaseResult> {
  const bad = checkActor(i.verifiedBy, i.how, "--how (how you verified it independently, e.g. \"phoned the vendor at its listed number\")");
  if (bad) return bad;
  const m = await repo.getMessage(i.messageId);
  if (!m) return no("not_found", `no message ${i.messageId}`);
  if (!isQuarantined(m) || m.channel !== "email") return no("not_quarantined", "only a quarantined (or unverified) inbound email can be released");
  if ((await repo.listQuarantineResolutions({ messageId: m.id })).length) return no("already_resolved", "this message already has a recorded decision; ask the business to send it again if needed");
  const reason = heldReason(m);
  if (NOT_RELEASABLE.has(reason)) return no("not_releasable", reason.startsWith("bounce") ? "a delivery report is not a message from the business" : "the mail provider reported an authentication failure (likely spoofed); contact the business on a channel you already know and ask it to reply again");
  if ((m.job_id && i.jobId && i.jobId !== m.job_id) || (m.business_id && i.businessId && i.businessId !== m.business_id)) return no("wrong_target", "a held message is released only to the deal and business it was matched to");
  const jobId = m.job_id ?? i.jobId;
  const businessId = m.business_id ?? i.businessId;
  if (!jobId || !businessId) return no("needs_target", "this message matched no deal: pass --job <job id> and --business <business id> (see `show`)");
  const job = await repo.getJob(jobId);
  if (!job) return no("not_found", `no job ${jobId}`);
  if (!RELEASABLE_STATES.has(job.state)) return no("job_not_open", `the deal is ${job.state}; a release can't change a deal past the approval stage (handle it with the business directly)`);
  const b = (await repo.getBusinesses(jobId)).find((x) => x.business_id === businessId);
  if (!b || !b.email) return no("unknown_business", `${businessId} is not an email business on ${jobId}`);
  // A message that matched nothing names its own sender: it must be the address on file for that business.
  if (!m.job_id && normalizeAddress(m.from_address ?? "") !== normalizeAddress(b.email)) return no("wrong_target", "the sender isn't the address on file for that business; add the address as the vendor's contact first, or ask the business to reply from it");
  if ((await repo.findSuppressions([normalizeAddress(b.email)])).length) return no("suppressed", "this business is suppressed (opted out or bounced); Haggle won't read it into a deal");
  const resolution = await repo.insertQuarantineResolution({
    id: newId("qr"), message_id: m.id, job_id: jobId, business_id: businessId, decision: "released", original_reason: reason, original_trust_reason: m.trust_reason,
    resolved_by: i.verifiedBy.trim(), verification: i.how.trim(), released_trust_reason: OPERATOR_VERIFIED,
  });
  if (!resolution) return no("already_resolved", "another operator decided on this message first");
  const at = (i.now ?? new Date()).toISOString();
  await repo.updateMessage(m.id, { kind: "reply", sender_trusted: true, trust_reason: OPERATOR_VERIFIED, parse_status: "pending", job_id: jobId, business_id: businessId });
  // Its Message-ID is not adopted for threading: Haggle keeps replying in the verified thread.
  await repo.updateBusiness(jobId, businessId, { last_reply_at: at }, { ifStatus: ["contacted", "question", "no_reply", "ringing", "replied", "quoted", "silent"] });
  await repo.updateBusiness(jobId, businessId, { status: "replied" }, { ifStatus: ["contacted", "question", "no_reply", "ringing"] });
  const why = explainQuarantine(reason);
  await repo.appendEvent(jobId, "quarantine_released", {
    business_id: businessId, message_id: m.id, resolution_id: resolution.id, original_reason: reason, verified_by: resolution.resolved_by, how: resolution.verification.slice(0, 200), trust_reason: OPERATOR_VERIFIED,
    summary: `An operator released a held email from ${b.name} after verifying it (${resolution.verification.slice(0, 80)}); it is read as a quote only, never as a booking or payment details`,
    board_line: `Held email released by an operator (was: ${why.board.slice(0, 50)})`,
  });
  await repo.touchJob(jobId);
  return { ok: true, jobId, businessId, messageId: m.id, resolution };
}

/** Record that a held message stays unread. */
export async function rejectQuarantined(repo: Repo, i: { messageId: string; by: string; why: string }): Promise<RejectResult> {
  const bad = checkActor(i.by, i.why, "--why (what you checked)");
  if (bad) return bad;
  const m = await repo.getMessage(i.messageId);
  if (!m) return no("not_found", `no message ${i.messageId}`);
  if (!isQuarantined(m)) return no("not_quarantined", "only a quarantined (or unverified) inbound message can be rejected");
  const resolution = await repo.insertQuarantineResolution({
    id: newId("qr"), message_id: m.id, job_id: m.job_id, business_id: m.business_id, decision: "rejected", original_reason: heldReason(m), original_trust_reason: m.trust_reason,
    resolved_by: i.by.trim(), verification: i.why.trim(), released_trust_reason: null,
  });
  if (!resolution) return no("already_resolved", "this message already has a recorded decision");
  if (m.job_id) {
    await repo.appendEvent(m.job_id, "quarantine_rejected", { ...(m.business_id ? { business_id: m.business_id } : {}), message_id: m.id, resolution_id: resolution.id, original_reason: resolution.original_reason, by: resolution.resolved_by });
    await repo.touchJob(m.job_id);
  }
  return { ok: true, jobId: m.job_id, messageId: m.id, resolution };
}

/** Mask what an operator's terminal (or a pasted log) shouldn't show: addresses, numbers, tokens, links. */
export function redactPreview(text: string): string {
  return text
    .replace(/HGR-[A-HJ-NP-Z2-9]{10}/gi, "HGR-<token>")
    .replace(/\bhttps?:\/\/([^\s/]+)[^\s]*/gi, (_m, host: string) => `<link ${host}>`)
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_m, first: string, domain: string) => `${first}***@${domain}`)
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "<number>")
    .replace(/\b\d{6,}\b/g, "<digits>");
}

export interface QuarantineEntry {
  message_id: string;
  job_id: string | null;
  business_id: string | null;
  from: string;
  subject: string;
  received_at: string;
  reason: string;
  explanation: string;
  action: string;
  attachments: number;
  decision: QuarantineResolutionRow["decision"] | null;
  /** Redacted, quoted history removed, at most 400 characters. UNTRUSTED text. */
  preview: string;
}

export function quarantineEntry(m: MessageRow, resolution: QuarantineResolutionRow | null): QuarantineEntry {
  const reason = heldReason(m);
  const why = explainQuarantine(reason);
  return {
    message_id: m.id, job_id: m.job_id, business_id: m.business_id, from: redactPreview(m.from_address ?? "(unknown)"), subject: redactPreview(m.subject ?? "").slice(0, 120),
    received_at: m.created_at, reason, explanation: why.explanation, action: why.action, attachments: m.attachments.length, decision: resolution?.decision ?? null,
    preview: redactPreview(cleanEmailBody(m.body_text ?? "").replace(/\s+/g, " ").trim()).slice(0, 400),
  };
}

/** Held messages, newest first; decided ones only with `includeResolved`. */
export async function listQuarantine(repo: Repo, q: { jobId?: string; limit?: number; includeResolved?: boolean } = {}): Promise<QuarantineEntry[]> {
  const msgs = await repo.listQuarantinedMessages({ ...(q.jobId ? { jobId: q.jobId } : {}), limit: q.limit ?? 100 });
  const decided = new Map((await repo.listQuarantineResolutions({ ...(q.jobId ? { jobId: q.jobId } : {}), limit: 1000 })).map((r) => [r.message_id, r]));
  // Bounce reports are delivery bookkeeping, not mail to review.
  return msgs.filter((m) => !heldReason(m).startsWith("bounce")).map((m) => quarantineEntry(m, decided.get(m.id) ?? null)).filter((e) => q.includeResolved || e.decision === null);
}
