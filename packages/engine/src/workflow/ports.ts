// Every external dependency of the engine is a port, so mock mode and live mode run the same
// workflow code. Live (v5): Inkbox email + attachments, Claude extractor, Partner's brain, x402
// payer; phone/A2A ports are absent until enabled, so those businesses are reported "unavailable".
// Mock (labelled DEMO everywhere): SimFleet (email + simulated calls), inline attachments, StubBrain.
import type { Brain } from "@haggle/core/contracts";
import type { ExtractedFile, PdfFile } from "../inbound/attachments.ts";
import type { OutboundEmail, SendOutcome } from "../outbound/primitiveSender.ts";
import type { QuoteExtraction } from "../parsing/extraction.ts";
import type { ExtractionRequest } from "../parsing/parseReply.ts";
import type { PayerClient } from "../payments/x402Challenge.ts";
import type { StripePort } from "../payments/stripe.ts";
import type { MessageRow, Mode, Repository } from "../store/types.ts";

export interface EmailPort {
  send(msg: OutboundEmail): Promise<SendOutcome>;
}

/** A Voice AI call request. `reason` is the task brief (≤ 2,000 chars) and says it is an AI assistant. */
export interface PhoneCallRequest {
  jobId: string;
  businessId: string;
  toNumber: string; // pinned E.164 snapshot
  reason: string;
  idempotencyKey: string;
}

/**
 * Places outbound calls. Results come back later as one call-ended event, handed to
 * HaggleEngine.ingestCall(). Absent in live mode until calls are explicitly enabled.
 */
export interface PhonePort {
  placeCall(req: PhoneCallRequest): Promise<{ callId: string }>;
}

export interface ExtractorPort {
  extract(input: { request: ExtractionRequest; bodyText: string; pdfs: PdfFile[]; message: MessageRow }): Promise<QuoteExtraction>;
}

export interface AttachmentPort {
  load(message: MessageRow): Promise<ExtractedFile[]>;
}

export interface PayerPort {
  client: PayerClient;
  signer: unknown;
  /** True when payments are simulated (no real signing key, receipts are DEMO). */
  simulated: boolean;
  /** Set when no payment rail is enabled: approval records a refused payment and asks no seller for an invoice. */
  disabledReason?: string;
}

export interface EngineConfig {
  mode: Mode;
  inboxDomain: string;
  collectionWindowMs: number;
  negotiationWindowMs: number;
  approvalTtlMs: number;
  globalPaymentCapCents: number;
  maxRounds: number;
  /**
   * v5 (Inkbox): one buyer identity mailbox for every job. Replies are matched by thread,
   * In-Reply-To and the [HG-code] subject tag instead of a per-job address. Omit for per-job inboxes.
   */
  sharedInbox?: string;
  /** Default per-job order cap (settings) when deal() has no budget. */
  defaultSpendingCapCents?: number;
  /** Hard ceiling the settings cap can never exceed (operator env, not the model). */
  spendingCapCeilingCents?: number;
  /**
   * Who deal() may contact: exact emails, "@domain" entries, or E.164 numbers. Undefined = anyone
   * (mock mode). Live mode sets it to the simulated fleet + HAGGLE_ALLOWED_RECIPIENTS.
   */
  recipientAllowlist?: string[];
}

export interface EngineDeps {
  repo: Repository;
  email: EmailPort;
  /** Optional: Voice AI calls (mock: simulated fleet; live: only when explicitly enabled). */
  phone?: PhonePort;
  extractor: ExtractorPort;
  attachments: AttachmentPort;
  brain: Brain;
  payer: PayerPort;
  /**
   * v5 payment rail: Stripe test mode (live) or its labelled simulation (mock). When present it is
   * THE rail: approval no longer emails an x402 invoice request; pay() charges the approved deposit.
   */
  stripe?: StripePort;
  config: EngineConfig;
  now?: () => Date;
  /** Mock mode: deliver due simulated replies before each advance. */
  onTick?: () => Promise<void>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Inline attachment bytes (simulated messages and small JSON parts). */
export const inlineAttachments: AttachmentPort = {
  async load(m) {
    return m.attachments
      .filter((a) => a.content_base64)
      .map((a) => {
        const name = (a.filename ?? "").toLowerCase();
        const kind = a.content_type === "application/pdf" || name.endsWith(".pdf") ? ("pdf" as const) : ("json" as const);
        return { kind, filename: a.filename ?? "attachment", data: Buffer.from(a.content_base64!, "base64") };
      });
  },
};
