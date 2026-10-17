// Every external dependency of the engine is a port, so mock mode and live mode run the same
// workflow code. Live: Primitive sender, Claude extractor, Primitive attachments, Partner's brain,
// x402 payer. Mock (labelled DEMO everywhere): SimFleet, SimExtractor, inline attachments, StubBrain.
import type { Brain } from "@haggle/core/contracts";
import type { ExtractedFile, PdfFile } from "../inbound/attachments.ts";
import type { OutboundEmail, SendOutcome } from "../outbound/primitiveSender.ts";
import type { QuoteExtraction } from "../parsing/extraction.ts";
import type { ExtractionRequest } from "../parsing/parseReply.ts";
import type { PayerClient } from "../payments/x402Challenge.ts";
import type { MessageRow, Mode, Repository } from "../store/types.ts";

export interface EmailPort {
  send(msg: OutboundEmail): Promise<SendOutcome>;
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
}

export interface EngineConfig {
  mode: Mode;
  inboxDomain: string;
  collectionWindowMs: number;
  negotiationWindowMs: number;
  approvalTtlMs: number;
  globalPaymentCapCents: number;
  maxRounds: number;
}

export interface EngineDeps {
  repo: Repository;
  email: EmailPort;
  extractor: ExtractorPort;
  attachments: AttachmentPort;
  brain: Brain;
  payer: PayerPort;
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
