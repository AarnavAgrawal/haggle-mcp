// Outbound email over Primitive. Every logical send has a caller-chosen idempotency key, so a
// retry (or a crash between send and record) can never send a second copy, and Primitive's
// keyless 5-minute dedupe never silently drops a deliberate resend.
//
// Adapted from quote-broker@8a68559 src/channels/email.ts (Partner): SDK `send` with an
// idempotency key, recipient-rejection check, Message-ID lookup after send. Changes for Haggle
// v3:
//   - From is the job's own inbox (per-job identity), passed per call, never a global address.
//   - In-thread replies use `send` to the pinned business address with explicit In-Reply-To /
//     References. The SDK's `reply()` (and quote-broker's `replyToEmail`) address the reply to
//     the inbound's Reply-To first, which a business email could point anywhere. Here the
//     recipient never comes from email content.
//   - JSON protocol parts (rfq.json, counter.json, accept.json, interaction.json) attach inline.
//   - The client is injected; tests never send.

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
}

export interface OutboundEmail {
  from: string; // job inbox, e.g. job-7f3k@brave-dog.primitive.email
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

/** The slice of the Primitive client this module uses; tests pass a fake. */
export interface SenderClient {
  send(
    input: {
      from: string;
      to: string;
      subject: string;
      bodyText?: string;
      thread?: { inReplyTo?: string; references?: string[] };
      attachments?: { filename: string; content_type?: string; content_base64: string }[];
    },
    options?: { idempotencyKey?: string; timeout?: number },
  ): Promise<{ id: string; status: string; accepted: string[]; rejected: string[]; idempotentReplay: boolean }>;
}

export class SendRejected extends Error {
  override name = "SendRejected";
  readonly status: string;
  readonly rejected: string[];
  constructor(status: string, rejected: string[]) {
    super(`recipient rejected (${status})`);
    this.status = status;
    this.rejected = rejected;
  }
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:._-]{8,200}$/;

/** "Re: " prefix applied once, so in-thread subjects keep Gmail threading. */
export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

export async function sendEmail(
  client: SenderClient,
  msg: OutboundEmail,
  lookupMessageId?: (providerId: string) => Promise<string | null>,
): Promise<SendOutcome> {
  if (!IDEMPOTENCY_KEY.test(msg.idempotencyKey)) throw new TypeError("idempotencyKey must be 8-200 chars of [A-Za-z0-9:._-]");
  const result = await client.send(
    {
      from: msg.from,
      to: msg.to,
      subject: msg.thread ? replySubject(msg.subject) : msg.subject,
      bodyText: msg.bodyText,
      ...(msg.thread ? { thread: { inReplyTo: msg.thread.inReplyTo, references: msg.thread.references } } : {}),
      ...(msg.attachments?.length
        ? {
            attachments: msg.attachments.map((a) => ({
              filename: a.filename,
              content_type: a.contentType,
              content_base64: Buffer.from(a.content).toString("base64"),
            })),
          }
        : {}),
    },
    { idempotencyKey: msg.idempotencyKey, timeout: 15_000 },
  );
  if (result.rejected.length > 0 && result.accepted.length === 0) throw new SendRejected(result.status, result.rejected);
  return {
    providerId: result.id,
    status: result.status,
    idempotentReplay: result.idempotentReplay,
    messageId: lookupMessageId ? await lookupMessageId(result.id).catch(() => null) : null,
  };
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
