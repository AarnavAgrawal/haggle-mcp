// The Primitive webhook edge: verify, map, and decide sender trust. No I/O and no database:
// the HTTP route (apps/mcp POST /inbound) calls these, then hands the result to ingestion.
//
// Adapted from quote-broker@8a68559 src/webhooks/primitive.ts (Partner): signature check on the
// raw body via `handleWebhook`, endpoint-id pinning, `toInbound` mapping, and
// `isTrustedSender` anchoring. Changes for Haggle v3:
//   - From is parsed with the SDK's strict `parseHeaderAddress` (the SDK warns that regexing the
//     header or using the envelope sender is unsafe); an unparseable From is untrusted.
//   - recipients (rcpt_to + To) are kept so the matcher can route by job inbox.
//   - one `senderTrust` verdict with evidence, used for businesses, approvers and x402 payees alike.
import {
  handleWebhook,
  isTrustedSender,
  parseHeaderAddress,
  type EmailReceivedEvent,
  type TrustReason,
} from "@primitivedotdev/sdk/webhook";

export interface InboundAttachmentMeta {
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  partIndex: number;
  tarPath: string;
}

export interface InboundMessage {
  providerEventId: string;
  eventType: string;
  providerEmailId: string;
  threadId: string | null;
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  /** Strict-parsed From address, lowercased; null when the header is missing or ambiguous. */
  from: string | null;
  to: string[];
  subject: string | null;
  bodyText: string | null;
  attachments: InboundAttachmentMeta[];
  attachmentsDownloadUrl: string | null;
}

export type WebhookVerdict =
  | { ok: true; event: EmailReceivedEvent }
  | { ok: false; status: 401; reason: "invalid_signature" | "wrong_endpoint" };

/** Verify the HMAC on the RAW body (never a re-serialised object) and pin the endpoint. */
export function verifyWebhook(rawBody: string, headers: Headers, opts: { secret: string; endpointId?: string }): WebhookVerdict {
  let event: EmailReceivedEvent;
  try {
    event = handleWebhook({ body: rawBody, headers, secret: opts.secret });
  } catch {
    return { ok: false, status: 401, reason: "invalid_signature" };
  }
  if (opts.endpointId && event.delivery.endpoint_id !== opts.endpointId) return { ok: false, status: 401, reason: "wrong_endpoint" };
  return { ok: true, event };
}

const lower = (a: string) => a.trim().toLowerCase();

export function toInbound(event: EmailReceivedEvent): InboundMessage {
  const e = event.email;
  const parsed = e.parsed.status === "complete" ? e.parsed : null;
  const to = new Set<string>([...(e.smtp.rcpt_to ?? []).map(lower)]);
  const headerTo = parseHeaderAddress(e.headers.to);
  if (headerTo) to.add(lower(headerTo.address));
  return {
    providerEventId: event.id,
    eventType: event.event,
    providerEmailId: e.id,
    threadId: e.thread_id ?? null,
    messageId: e.headers.message_id,
    inReplyTo: parsed?.in_reply_to ?? [],
    references: parsed?.references ?? [],
    from: (() => {
      const a = parseHeaderAddress(e.headers.from);
      return a ? lower(a.address) : null;
    })(),
    to: [...to],
    subject: e.headers.subject,
    bodyText: parsed?.body_text ?? null,
    attachments: (parsed?.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.content_type,
      sizeBytes: a.size_bytes,
      partIndex: a.part_index,
      tarPath: a.tar_path,
    })),
    attachmentsDownloadUrl: parsed?.attachments_download_url ?? null,
  };
}

export interface AuthEvidence {
  dmarc: string | null;
  dmarcPolicy: string | null;
  dmarcFromDomain: string | null;
  spf: string | null;
  alignedDkimDomains: string[];
}

export type TrustVerdict =
  // "inkbox-org-identity": a same-org Inkbox identity pinned on the job, outbound not verified (see live/inkbox.ts).
  // "external-reply-token" / "external-dmarc-aligned": a reply from outside Inkbox proven by inbound/senderAuth.ts.
  | { trusted: true; address: string; reason: "trusted" | "inkbox-org-identity" | "external-reply-token" | "external-dmarc-aligned"; evidence: AuthEvidence }
  | { trusted: false; retryable: boolean; reason: TrustReason | "no-expected-address" | InkboxTrustReason; evidence: AuthEvidence };

/** Inkbox (v5) verdicts: see live/inkbox.ts `inkboxSenderTrust`. */
export type InkboxTrustReason = "unverified-external-sender" | "sender-not-verifiable" | "inkbox-verify-unavailable";

/**
 * Is this signed webhook event really from `expected` (a business snapshot address, the
 * approver, or an x402 payee)? The ONLY place the engine answers that question.
 * `retryable` (DMARC temperror) means: answer the webhook with 5xx so Primitive redelivers.
 */
export function senderTrust(event: EmailReceivedEvent, expected: string): TrustVerdict {
  const a = event.email.auth;
  const evidence: AuthEvidence = {
    dmarc: a?.dmarc ?? null,
    dmarcPolicy: a?.dmarcPolicy ?? null,
    dmarcFromDomain: a?.dmarcFromDomain ?? null,
    spf: a?.spf ?? null,
    alignedDkimDomains: (a?.dkimSignatures ?? []).filter((s) => s.result === "pass" && s.aligned).map((s) => s.domain),
  };
  const address = lower(expected);
  const domain = address.split("@")[1];
  if (!domain) return { trusted: false, retryable: false, reason: "no-expected-address", evidence };
  const r = isTrustedSender(event, { domain, sender: address });
  return r.trusted
    ? { trusted: true, address, reason: "trusted", evidence }
    : { trusted: false, retryable: r.retryable, reason: r.reason, evidence };
}
