// The engine's provider-neutral outbound email shape, plus the subject and idempotency-key helpers.
// live/inkbox.ts `inkboxEmail` sends these through Inkbox; the simulated fleet records them. Every
// logical send has a caller-chosen idempotency key, so a retry (or a crash between send and record)
// can never send a second copy. Moved here unchanged from the retired Primitive sender module.
//   - In-thread replies go to the pinned business address with explicit In-Reply-To / References;
//     the recipient never comes from email content (never the inbound's Reply-To).
//   - JSON protocol parts (rfq.json, counter.json, accept.json) attach inline.

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutboundEmail {
  from: string; // the buyer mailbox (or a job inbox address)
  to: string; // pinned business / approver address
  subject: string;
  bodyText: string;
  /** Present for in-thread messages: the RFC Message-ID we are answering, and its chain. */
  thread?: { inReplyTo: string; references: string[] };
  attachments?: OutboundAttachment[];
  idempotencyKey: string;
}

export interface SendOutcome {
  providerId: string;
  status: string;
  idempotentReplay: boolean;
  messageId: string | null;
}

/** "Re: " prefix applied once, so in-thread subjects keep Gmail threading. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

/** Deterministic idempotency keys: one logical send = one key, forever. */
export const sendKeys = {
  rfq: (jobId: string, businessId: string) => `rfq:${jobId}:${businessId}`,
  followUp: (jobId: string, businessId: string, n: number) => `followup:${jobId}:${businessId}:${n}`,
  answer: (questionId: string) => `answer:${questionId}`,
  counter: (jobId: string, businessId: string, round: number) => `counter:${jobId}:${businessId}:r${round}`,
  approvalRequest: (approvalId: string) => `approval:${approvalId}`,
  accept: (approvalId: string) => `accept:${approvalId}`,
  payment: (challengeStepId: string) => `pay:${challengeStepId}`,
  cancel: (jobId: string, businessId: string) => `cancel:${jobId}:${businessId}`,
};
