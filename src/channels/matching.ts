// PURE: decide which job/vendor an inbound email belongs to (DESIGN.md §10.5).
//
// The webhook loads candidate rows from the database and passes them in; this
// function only applies the matching rules, in priority order:
//   1. Primitive thread id equals a stored vendor thread id.
//   2. In-Reply-To / References contains a stored outbound Message-ID.
//   3. Subject carries [QB-<code>] AND the From address is a vendor on that job.
// Anything else is unmatched. An inbound email never creates a job.

export interface VendorCandidate {
  vendorId: string;
  jobId: string;
  shortCode: string;
  email: string | null;
  threadId: string | null;
  outboundMessageId: string | null;
}

export interface MatchInput {
  threadId: string | null;
  inReplyTo: string[];
  references: string[];
  subject: string | null;
  from: string;
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

type Via = "thread" | "message_id" | "subject_tag";

export type MatchResult =
  | { kind: "vendor"; vendorId: string; jobId: string; via: Via }
  | { kind: "approval"; approvalId: string; jobId: string; via: Via }
  | { kind: "unmatched" };

const SUBJECT_TAG = /\[QB-([A-Z0-9]{4})\]/i;

export function subjectShortCode(subject: string | null): string | null {
  const m = subject?.match(SUBJECT_TAG);
  return m ? m[1]!.toUpperCase() : null;
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
  vendors: VendorCandidate[],
  approvals: ApprovalCandidate[] = [],
): MatchResult {
  const vendorHit = (v: VendorCandidate, via: Via): MatchResult => ({ kind: "vendor", vendorId: v.vendorId, jobId: v.jobId, via });
  const approvalHit = (a: ApprovalCandidate, via: Via): MatchResult => ({ kind: "approval", approvalId: a.approvalId, jobId: a.jobId, via });

  // 1. Thread id.
  if (msg.threadId) {
    const a = approvals.find((c) => c.threadId === msg.threadId);
    if (a) return approvalHit(a, "thread");
    const v = vendors.find((c) => c.threadId === msg.threadId);
    if (v) return vendorHit(v, "thread");
  }

  // 2. In-Reply-To / References against our outbound Message-IDs.
  const refs = new Set([...msg.inReplyTo, ...msg.references].map(normalizeMessageId));
  if (refs.size > 0) {
    const hits = (id: string | null) => id !== null && refs.has(normalizeMessageId(id));
    const a = approvals.find((c) => hits(c.outboundMessageId));
    if (a) return approvalHit(a, "message_id");
    const v = vendors.find((c) => hits(c.outboundMessageId));
    if (v) return vendorHit(v, "message_id");
  }

  // 3. Subject tag + the sender must be a party on that job (a vendor, or the
  //    approver). Both are required: a subject tag alone is trivially forgeable.
  const code = subjectShortCode(msg.subject);
  if (code) {
    const from = normalizeAddress(msg.from);
    const a = approvals.find((c) => c.shortCode.toUpperCase() === code && normalizeAddress(c.approverEmail) === from);
    if (a) return approvalHit(a, "subject_tag");
    const v = vendors.find((c) => c.shortCode.toUpperCase() === code && c.email !== null && normalizeAddress(c.email) === from);
    if (v) return vendorHit(v, "subject_tag");
  }

  return { kind: "unmatched" };
}
