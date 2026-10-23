// Every external dependency of the engine is a port, so mock mode and live mode run the same
// workflow code. Live (v5): Inkbox email + attachments, Claude extractor, Partner's brain, x402
// payer; phone/A2A ports are absent until enabled, so those businesses are reported "unavailable".
// Mock (labelled DEMO everywhere): SimFleet (email + simulated calls), inline attachments, StubBrain.
import type { Brain } from "../contract.ts";
import { imageContentType, type ExtractedFile, type ImageFile, type PdfFile } from "../inbound/attachments.ts";
import type { OutboundEmail, SendOutcome } from "../outbound/primitiveSender.ts";
import type { QuoteExtraction } from "../parsing/extraction.ts";
import type { ExtractionRequest } from "../parsing/parseReply.ts";
import type { QuestionAnswerInput } from "../parsing/answerQuestion.ts";
import type { PayerClient } from "../payments/x402Challenge.ts";
import type { StripePort } from "../payments/stripe.ts";
import type { MessageRow, Mode, Repository } from "../store/types.ts";

export interface EmailPort {
  send(msg: OutboundEmail): Promise<SendOutcome>;
}

/** Why a send failed, in the engine's terms; adapters map provider errors to it (live/inkbox.ts mapInkboxError). */
export type SendFailureReason = "rate_limited" | "provider_error" | "invalid_address" | "opted_out" | "not_opted_in" | "channel_not_configured";

/**
 * A classified send failure. Retryable ones keep the business pending and the same channel is
 * tried again after retryAfterMs (same idempotency key); the rest move on to the next channel.
 */
export class ChannelSendError extends Error {
  override name = "ChannelSendError";
  readonly reason: SendFailureReason;
  readonly retryable: boolean;
  readonly retryAfterMs: number;
  /** The provider may have acted (e.g. a call may be ringing): never retried, never re-sent. */
  readonly ambiguous: boolean;
  constructor(reason: SendFailureReason, retryable: boolean, retryAfterMs: number, message: string, ambiguous = false) {
    super(message);
    this.reason = reason;
    this.retryable = retryable && !ambiguous;
    this.retryAfterMs = retryAfterMs;
    this.ambiguous = ambiguous;
  }
}

/**
 * The buyer identity's Voice AI answering instructions (inbound calls). The engine replaces them
 * with the open requests so a business calling back is matched to its request. Optional.
 */
export interface VoiceContextPort {
  setInstructions(instructions: string): Promise<void>;
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

/** One agent message on an A2A task (the seller's side): readable text + structured data parts. */
export interface A2AAgentMessage {
  messageId: string;
  text: string;
  data: Record<string, unknown>[];
}

export interface A2ATaskView {
  taskId: string;
  contextId: string;
  /** submitted | working | input_required | completed | failed | canceled | rejected | unknown */
  state: string;
  agentMessages: A2AAgentMessage[];
}

/**
 * Buyer-to-seller A2A tasks (Inkbox A2A 1.0). Haggle only sends to a business's PINNED Agent Card
 * URL; results come back on that task (webhook a2a.sent_task.updated, or getTask polling).
 */
export interface A2APort {
  /** Start a task, or continue one (contextId + taskId) for a counteroffer. `messageId` makes resends idempotent. */
  send(req: { cardUrl: string; text: string; data: Record<string, unknown>; messageId: string; contextId?: string; taskId?: string }): Promise<{ taskId: string; contextId: string; state: string }>;
  getTask(req: { cardUrl: string; taskId: string }): Promise<A2ATaskView>;
}

/** iMessage from the buyer identity: approval requests to the settings approver only. */
export interface IMessagePort {
  send(req: { to: string; text: string; idempotencyKey: string }): Promise<{ messageId: string }>;
}

/**
 * SMS from the buyer identity's own number (Inkbox sendText): update texts to the human
 * (config.notifyPhone, else the settings approver) and follow-ups to phone businesses.
 */
export interface SmsPort {
  send(req: { to: string; text: string; idempotencyKey: string }): Promise<{ messageId: string }>;
  /**
   * Optional: texts sent to this number since it last texted back (Inkbox refuses more than 10).
   * Lets a restarted server keep the remaining texts for questions and approvals.
   */
  unanswered?(to: string): Promise<number>;
}

export interface ExtractorPort {
  extract(input: { request: ExtractionRequest; bodyText: string; pdfs: PdfFile[]; images?: ImageFile[]; message: MessageRow }): Promise<QuoteExtraction>;
  /**
   * Optional (Claude): answer a business's question from the request's own facts, or null to leave
   * it for the human. Without it every question goes to the human.
   */
  answerQuestion?(input: QuestionAnswerInput): Promise<{ answer: string; basis: string } | null>;
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
  /**
   * Calls a business places TO Haggle are matched by caller number. Caller ID can be spoofed, so such
   * transcripts are trusted (can become a quote) only when the operator opts in. Default: false.
   */
  trustInboundCallerId?: boolean;
  /** Wait this long after deal() before placing Voice AI RFQ calls, so the call can cite the best real competing quote. Default 0. */
  callDelayMs?: number;
  /** Call an email business with an allowlisted phone when its email is unanswered this long (needs the phone port). Off when unset. */
  escalateEmailToCallAfterMs?: number;
  /** Local hours [start, end) in the workspace timezone when Haggle may place calls. Absent = any time. */
  callHours?: { start: number; end: number };
  /** No new call to a number within this long after the last one (either direction). Default 2 min. */
  callCooldownMs?: number;
  /**
   * The gap before a counteroffer call to a number Haggle just called (the business quoted on that
   * call). Default min(callCooldownMs, 60 s), never under 30 s (0 when callCooldownMs is 0).
   */
  counterCallGapMs?: number;
  /** The floor under counterCallGapMs. Default 30 s (demo speed lowers it); a 0 cooldown still means no spacing. */
  minCallGapMs?: number;
  /** A scheduled call whose placement failed (e.g. 503 hosted_agent_at_capacity) is retried after this long. Default 60 s. */
  callRetryMs?: number;
  /** A business message keeps the window open at least this long, so a half-answered business can finish. */
  replyGraceMs?: number;
  /**
   * Business questions Haggle can't answer from the request are texted to the human together: as
   * soon as no other business is still to reply, or once the oldest has waited this long. Default 45 s.
   */
  questionBatchMs?: number;
  /**
   * An unanswered question holds the collection window for its business at most this long (the rest
   * keep quoting meanwhile); answering it reopens the wait for that business. Default replyGraceMs, else min(window, 15 min).
   */
  questionHoldMs?: number;
  /**
   * A business Haggle just asked for something (a missing-info or exact-total follow-up, the answer
   * to its question) holds the collection window at most this long after the ask (a call scheduled
   * for later counts from its time), so it can still answer; one that never does doesn't keep the
   * deal waiting. Default min(questionHoldMs ?? replyGraceMs, 3 min).
   */
  followUpHoldMs?: number;
  /**
   * The human texted (SMS port on) only when they need to act or money moved: business questions,
   * "all quotes are in" with the recommendation to approve by text, an approval, the payment result,
   * a deal that failed. Their reply answers the open question. Falls back to the settings approver.
   */
  notifyPhone?: string;
  /**
   * Only an out-of-band human answer approves: a coded reply from the workspace approver's phone
   * (or, with emailApprovalByCode, email). The MCP client's form, the approval card's button and
   * the simulated human are refused, because a tool call can't prove a human made it. Default:
   * on in live mode, off in mock mode (DEMO).
   */
  outOfBandApprovalsOnly?: boolean;
  /**
   * The signed-in account owner approves, reports payment, cancels a confirmed booking and authorizes a
   * callback in the Haggle web app (approval channel "web", recorded as web:<actor>). Reached only
   * through the service-token routes (apps/mcp/src/service/approvals.ts), never an MCP tool, so it holds
   * under outOfBandApprovalsOnly too. Default on; false refuses every web decision (web_approvals_off).
   */
  webApprovals?: boolean;
  /**
   * The workspace whose open requests the shared Voice AI line may describe to callers (every
   * workspace shares one buyer identity). Default DEFAULT_WORKSPACE_ID; other workspaces' jobs are
   * never in the answering instructions.
   */
  voiceWorkspaceId?: string;
  /**
   * Replies from mailboxes Inkbox can't authenticate (Gmail, Outlook, a vendor's own domain).
   * "off" (default): never trusted. "reply_token": trusted only from the pinned address, in Haggle's
   * own thread, quoting the business's reply token (inbound/senderAuth.ts), with no failing
   * authentication evidence. Needs replyTokenSecret.
   */
  externalSenders?: "off" | "reply_token";
  /** Server secret (>= 16 chars) for reply tokens. Required with externalSenders "reply_token". */
  replyTokenSecret?: string;
  /** This process's name in job leases (default: one random id per process). */
  instanceId?: string;
  /** How long a job lease lasts without release (default 5 min). */
  leaseTtlMs?: number;
  /**
   * Manual payment handoff: no money moves through Haggle. After the human's approval the business
   * is asked how it takes payment; its instructions are recorded (untrusted text, never followed);
   * the human pays it directly and texts PAID <code>. Only then is the business told the customer
   * reports having paid. Takes precedence over Stripe.
   */
  manualPaymentHandoff?: boolean;
  /** How long a quote stays approvable as is when the business stated no valid-until date (default 7 days); a stale one is re-confirmed first. */
  quoteValidityMs?: number;
  /** How long Haggle waits for the business's re-confirmation of a stale quote before telling the human (default 24 h). */
  reconfirmTimeoutMs?: number;
  /** Manual handoff: how long the business has to confirm the booking before the human and operator are told (default 24 h). */
  bookingTimeoutMs?: number;
  /** Manual handoff: how long the business has to send payment instructions before the human and operator are told (default 48 h). */
  handoffTimeoutMs?: number;
  /** Wrong approval codes before an approval locks. Default 5. */
  maxApprovalAttempts?: number;
  /**
   * Email approval from an approver whose mail Inkbox can't authenticate (any non-Inkbox address):
   * accept a reply only when it comes from the approver's exact address, in the approval's thread,
   * and its first line carries this approval's one-time code (APPROVE <code> / NO <code>). The code
   * goes only to the human's inbox, phone and approval card, never to the model. Wrong codes count
   * toward the lockout. Off: only authenticated senders can approve by email.
   */
  emailApprovalByCode?: boolean;
  /** The buyer identity as businesses see it (get_identity; Voice AI instructions). */
  identity?: { name: string; phone?: string | null };
  /**
   * Who the AI assistant acts for when the request doesn't say (a detail like "Customer: Acme Labs"
   * wins): messages to businesses say "I'm an AI assistant ... on behalf of <name>". Default "a customer".
   */
  customerName?: string;
  /**
   * When businesses may be contacted unprompted (the first RFQ by email or iMessage, reminders to a
   * silent business): workflow/contactWindow.ts. Absent = any time and no reminders (mock mode, tests).
   * Live sets it (default Mon–Sat 08:00–19:00 in the workspace's timezone; contactWindowFromEnv).
   */
  contactWindow?: import("./contactWindow.ts").ContactWindowConfig;
}

export interface EngineDeps {
  repo: Repository;
  email: EmailPort;
  /** Optional: Voice AI calls (mock: simulated fleet; live: only when explicitly enabled). */
  phone?: PhonePort;
  /** Optional: A2A tasks to agent-ready businesses (mock: simulated fleet; live: only when enabled). */
  a2a?: A2APort;
  /** Optional: iMessage approval requests (live: only when enabled). */
  imessage?: IMessagePort;
  /** Optional: SMS updates to the human and follow-ups to phone businesses (live: only when enabled). */
  sms?: SmsPort;
  /** Optional: keeps the buyer's Voice AI answering instructions in sync with open requests (inbound callbacks). */
  voice?: VoiceContextPort;
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
  /** Optional: an LLM that chooses among the planner's truthful counter moves (validated; rules on failure). */
  strategist?: import("../negotiation/strategist.ts").StrategistPort;
  /** Optional: public reputation for real businesses (non-blocking; never for simulated vendors). */
  reputation?: import("../reputation/places.ts").ReputationPort;
  now?: () => Date;
  /** Mock mode: deliver due simulated replies before each advance. */
  onTick?: () => Promise<void>;
  /**
   * Live: look for inbound replies whose webhook never arrived (InboundReconciler.sweepJob) and
   * ingest them. Called before a negotiation round closes and before "all quotes are in" goes out,
   * so a just-missed reply counts. Returns how many items were recovered for the job; never throws.
   */
  reconcile?: (jobId: string) => Promise<number>;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/** Inline attachment bytes (simulated messages and small JSON parts). */
export const inlineAttachments: AttachmentPort = {
  async load(m) {
    return m.attachments
      .filter((a) => a.content_base64)
      .map((a): ExtractedFile => {
        const name = (a.filename ?? "").toLowerCase();
        const image = imageContentType(a.content_type, a.filename);
        const kind = a.content_type === "application/pdf" || name.endsWith(".pdf") ? ("pdf" as const) : image ? ("image" as const) : ("json" as const);
        return { kind, filename: a.filename ?? "attachment", data: Buffer.from(a.content_base64!, "base64"), ...(kind === "image" ? { contentType: image! } : {}) };
      });
  },
};
