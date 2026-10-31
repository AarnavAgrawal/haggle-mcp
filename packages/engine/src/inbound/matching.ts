// PURE: decide which job/business an inbound email belongs to.
//
// Adapted from quote-broker@8a68559 src/channels/matching.ts (Partner). Changes for Haggle v3:
//   - Rule 0: each job has its own inbox (job-<code>@<domain>), so the recipient address picks the
//     job before anything else, and mail to an unknown job inbox is unmatched.
//   - A business match by thread or Message-ID also requires the From address to be that
//     business's snapshot address. Anyone else posting into the thread is quarantined, so a
//     forwarded or spoofed reply can never become that business's quote or invoice.
//   - Subject tag is [HG-<code>]. Haggle no longer puts it in subjects (2026-10-30); it is still read
//     so replies in older threads keep matching.
//   - Rule 5 (no codes): a new email, not a reply, from a business's pinned address, matches when that
//     sender has exactly one open deal on the receiving mailbox ("sender_only", lower trust: never
//     enough for binding terms; see workflow/engine.ts ingest). Several -> held as "ambiguous_sender".
// Anything else is unmatched. An inbound email never creates a job.

export interface BusinessCandidate {
  businessId: string;
  jobId: string;
  shortCode: string;
  email: string; // immutable per-job snapshot
  threadId: string | null;
  outboundMessageId: string | null;
  /** Every Message-ID of Haggle's emails to this business on this job (the RFQ, reminders, counters, …). */
  outboundMessageIds?: string[];
}

/** A pending approval whose reply we are waiting for (the human's inbox). */
export interface ApprovalCandidate {
  approvalId: string;
  jobId: string;
  shortCode: string;
  approverEmail: string;
  threadId: string | null;
  outboundMessageId: string | null;
}

export interface MatchInput {
  /** Envelope/To recipients, bare addresses. */
  to: string[];
  threadId: string | null;
  inReplyTo: string[];
  references: string[];
  subject: string | null;
  /** Strict-parsed From address (never Reply-To or the SMTP envelope sender). */
  from: string;
}

export type Via = "thread" | "message_id" | "subject_tag" | "sender_only";

export type MatchResult =
  | { kind: "business"; businessId: string; jobId: string; via: Via }
  | { kind: "approval"; approvalId: string; jobId: string; via: Via }
  | { kind: "quarantine"; reason: "sender_mismatch"; businessId: string; jobId: string; via: Via }
  | { kind: "unmatched"; reason: "unknown_job_inbox" | "no_signal" | "ambiguous_sender" };

const SUBJECT_TAG = /\[HG-([A-Z0-9]{4,8})\]/i;
const JOB_INBOX = /^job-([a-z0-9]{4,8})@(.+)$/i;

export function subjectShortCode(subject: string | null): string | null {
  const m = subject?.match(SUBJECT_TAG);
  return m ? m[1]!.toUpperCase() : null;
}

/** `job-7f3k@brave-dog.primitive.email` -> "7F3K" when the domain is ours. */
export function jobInboxCode(address: string, inboxDomain: string): string | null {
  const m = normalizeAddress(address).match(JOB_INBOX);
  return m && m[2] === inboxDomain.toLowerCase() ? m[1]!.toUpperCase() : null;
}

export function jobInboxAddress(shortCode: string, inboxDomain: string): string {
  return `job-${shortCode.toLowerCase()}@${inboxDomain.toLowerCase()}`;
}

/** Normalize "<abc@x>" and "abc@x" to the same key. */
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").toLowerCase();
}

export function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase();
}

export function matchInbound(
  msg: MatchInput,
  businesses: BusinessCandidate[],
  approvals: ApprovalCandidate[] = [],
  inboxDomain?: string,
  /** Businesses on OPEN deals on the receiving mailbox whose pinned address is the sender (rule 5). */
  openBySender: BusinessCandidate[] = [],
): MatchResult {
  // 0. A job inbox recipient narrows every candidate to that job.
  if (inboxDomain) {
    const codes = new Set(msg.to.map((a) => jobInboxCode(a, inboxDomain)).filter((c): c is string => c !== null));
    if (codes.size > 0) {
      businesses = businesses.filter((b) => codes.has(b.shortCode.toUpperCase()));
      approvals = approvals.filter((a) => codes.has(a.shortCode.toUpperCase()));
      if (businesses.length === 0 && approvals.length === 0) return { kind: "unmatched", reason: "unknown_job_inbox" };
    }
  }

  const from = normalizeAddress(msg.from);
  const businessHit = (b: BusinessCandidate, via: Via): MatchResult =>
    normalizeAddress(b.email) === from
      ? { kind: "business", businessId: b.businessId, jobId: b.jobId, via }
      : { kind: "quarantine", reason: "sender_mismatch", businessId: b.businessId, jobId: b.jobId, via };
  const approvalHit = (a: ApprovalCandidate, via: Via): MatchResult => ({ kind: "approval", approvalId: a.approvalId, jobId: a.jobId, via });

  // 1. Thread id.
  if (msg.threadId) {
    const a = approvals.find((c) => c.threadId === msg.threadId);
    if (a) return approvalHit(a, "thread");
    const b = businesses.find((c) => c.threadId === msg.threadId);
    if (b) return businessHit(b, "thread");
  }

  // 2. In-Reply-To / References against our outbound Message-IDs.
  const refs = new Set([...msg.inReplyTo, ...msg.references].map(normalizeMessageId));
  if (refs.size > 0) {
    const hits = (id: string | null) => id !== null && refs.has(normalizeMessageId(id));
    const a = approvals.find((c) => hits(c.outboundMessageId));
    if (a) return approvalHit(a, "message_id");
    const b = businesses.find((c) => hits(c.outboundMessageId)) ?? businesses.find((c) => (c.outboundMessageIds ?? []).some(hits));
    if (b) return businessHit(b, "message_id");
  }

  // 3. Subject tag AND the sender is a party on that job. A tag alone is trivially forgeable.
  const code = subjectShortCode(msg.subject);
  if (code) {
    const a = approvals.find((c) => c.shortCode.toUpperCase() === code && normalizeAddress(c.approverEmail) === from);
    if (a) return approvalHit(a, "subject_tag");
    const b = businesses.find((c) => c.shortCode.toUpperCase() === code && normalizeAddress(c.email) === from);
    if (b) return businessHit(b, "subject_tag");
  }

  // 4. Mail to a job inbox from a business on that job, with no thread signals (e.g. the
  //    business wrote first, as reply-only accounts require).
  if (inboxDomain && msg.to.some((a) => jobInboxCode(a, inboxDomain))) {
    const b = businesses.find((c) => normalizeAddress(c.email) === from);
    if (b) return { kind: "business", businessId: b.businessId, jobId: b.jobId, via: "subject_tag" };
  }

  // 5. A new email (no thread signal of ours) from a pinned address: the deal only when the sender
  //    has exactly one open deal on this mailbox. Never a guess between several.
  const mine = new Map(openBySender.filter((c) => normalizeAddress(c.email) === from).map((c) => [`${c.jobId}\u0000${c.businessId}`, c]));
  if (mine.size === 1) {
    const b = [...mine.values()][0]!;
    return { kind: "business", businessId: b.businessId, jobId: b.jobId, via: "sender_only" };
  }
  if (mine.size > 1) return { kind: "unmatched", reason: "ambiguous_sender" };

  return { kind: "unmatched", reason: "no_signal" };
}
