// One interface for every vendor channel (DESIGN.md §9). Only email ships in
// core; the phone adapter (stretch) implements the same shape.

export interface OutboundMessage {
  jobId: string;
  vendorId?: string;
  approvalId?: string;
  to: string; // email address (or phone number for the phone adapter)
  subject: string; // ignored by phone
  bodyText: string;
  /** Reply in an existing thread: the RFC Message-ID we are answering. */
  inReplyToMessageId?: string;
  /** Full References chain for threading. */
  references?: string[];
  idempotencyKey: string;
}

export interface SendResult {
  providerId: string; // Primitive sent-email id
  messageId?: string; // RFC Message-ID, when the provider reports it
  threadId?: string;
}

export interface InboundAttachment {
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  partIndex: number;
  tarPath: string;
}

export interface InboundMessage {
  providerEventId: string; // for dedupe
  eventType: string; // "email.received", "email.bounced", ...
  providerId: string;
  threadId: string | null;
  messageId: string | null;
  inReplyTo: string[];
  references: string[];
  from: string; // bare address, lowercased
  subject: string | null;
  bodyText: string | null;
  attachments: InboundAttachment[];
  attachmentsDownloadUrl: string | null;
  /** Provider's SPF/DKIM/DMARC verdict was "legit". Not by itself an authorization. */
  senderAuthenticated: boolean;
}

export interface ChannelAdapter {
  channel: "email" | "phone";
  send(msg: OutboundMessage): Promise<SendResult>;
}
