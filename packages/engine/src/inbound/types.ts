// The engine's provider-neutral inbound email shape and sender-trust verdict. Inkbox mail
// (live/inkbox.ts `inkboxToInbound` / `inkboxSenderTrust`) and the simulated fleet (sim/fleet.ts)
// produce these; the engine's ingest() consumes them. Moved here unchanged from the retired
// Primitive webhook module (inbound/primitive.ts), so no type or verdict changed.

export interface InboundAttachmentMeta {
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  partIndex: number;
  /** The provider's key for the attachment (for Inkbox, the attachment filename getAttachment() needs). */
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

export interface AuthEvidence {
  dmarc: string | null;
  dmarcPolicy: string | null;
  dmarcFromDomain: string | null;
  spf: string | null;
  alignedDkimDomains: string[];
}

/**
 * Generic email-authentication refusal reasons (the same literals the legacy webhook SDK used, so
 * stored `trust_reason` values and their explanations stay valid). "sender-mismatch" is what
 * live/inkbox.ts `trustForSender` returns for an address other than the verified sender.
 */
export type SenderTrustReason =
  | "trusted"
  | "auth-missing"
  | "auth-suspicious"
  | "dmarc-temperror"
  | "auth-unknown"
  | "dmarc-domain-mismatch"
  | "from-header-multiple-addresses"
  | "from-header-invalid"
  | "from-domain-mismatch"
  | "sender-mismatch";

export type TrustVerdict =
  // "inkbox-org-identity": a same-org Inkbox identity pinned on the job, outbound not verified (see live/inkbox.ts).
  // "external-reply-token" / "external-dmarc-aligned": a reply from outside Inkbox proven by inbound/senderAuth.ts.
  | { trusted: true; address: string; reason: "trusted" | "inkbox-org-identity" | "external-reply-token" | "external-dmarc-aligned"; evidence: AuthEvidence }
  | { trusted: false; retryable: boolean; reason: SenderTrustReason | "no-expected-address" | InkboxTrustReason; evidence: AuthEvidence };

/** Inkbox (v5) verdicts: see live/inkbox.ts `inkboxSenderTrust`. */
export type InkboxTrustReason = "unverified-external-sender" | "sender-not-verifiable" | "inkbox-verify-unavailable";
