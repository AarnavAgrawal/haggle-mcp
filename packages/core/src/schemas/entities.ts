import { z } from "zod";
import {
  ApprovalId,
  ChallengeId,
  EmailAddress,
  EventId,
  IsoDateTime,
  JobId,
  MessageId,
  PaymentId,
  Provenance,
  QuestionId,
  QuoteId,
  RoundId,
  SellerId,
  SellerKind,
  evidenced,
} from "./common.ts";
import { Cents, NonNegativeCents, UsdcBaseUnits } from "./money.ts";
import { JobRequirements, RequirementCheck } from "./requirements.ts";
import { JobState, SellerConversationState } from "../domain/state-machine.ts";

// ---------------------------------------------------------------- Job

export const Job = z.object({
  id: JobId,
  state: JobState,
  /** Optimistic-concurrency version; every state change increments it. */
  version: z.number().int().nonnegative(),
  intent: z.string().min(3).max(2000),
  /** Short title derived from intent for the deal board header. */
  title: z.string().max(120),
  category: z.string().max(60).optional(),
  budget_cents: NonNegativeCents,
  /** Hard ceiling for any single payment on this job, ≤ budget. */
  spend_cap_cents: NonNegativeCents,
  deadline: IsoDateTime,
  /** Sellers must reply before this instant; derived from deadline if not given. */
  reply_by: IsoDateTime,
  requirements: JobRequirements,
  approver_email: EmailAddress,
  /** The job's own Primitive address; all seller correspondence uses it. */
  inbox: EmailAddress,
  max_negotiation_rounds: z.number().int().min(0).max(5),
  metadata: z.record(z.string(), z.string().max(500)).default({}),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  /** "mock" jobs never touch real email or money; surfaced on every view. */
  mode: z.enum(["live", "mock"]),
});
export type Job = z.infer<typeof Job>;

// ---------------------------------------------------------------- Sellers

export const SellerContact = z.object({
  id: SellerId,
  email: EmailAddress,
  display_name: z.string().max(120).optional(),
  kind: SellerKind,
  /** Domain is used to bind x402 payees to the seller that actually quoted. */
  domain: z.string().max(253),
  created_at: IsoDateTime,
});
export type SellerContact = z.infer<typeof SellerContact>;

export const SellerConversation = z.object({
  job_id: JobId,
  seller_id: SellerId,
  state: SellerConversationState,
  version: z.number().int().nonnegative(),
  /** RFC 5322 Message-ID of our RFQ; replies must reference it to correlate. */
  rfq_message_id: z.string().optional(),
  /** Every Message-ID in this thread, used to match In-Reply-To/References. */
  thread_message_ids: z.array(z.string()).default([]),
  last_inbound_at: IsoDateTime.optional(),
  last_outbound_at: IsoDateTime.optional(),
  /** True once Primitive has authenticated this seller's From address on this thread. */
  sender_verified: z.boolean().default(false),
  current_quote_id: QuoteId.optional(),
  rounds_used: z.number().int().nonnegative().default(0),
});
export type SellerConversation = z.infer<typeof SellerConversation>;

// ---------------------------------------------------------------- Email

/**
 * Sender authentication as reported by Primitive's inbound webhook
 * (`email.analysis.sender` and `email.auth`). Verdict strings are kept raw
 * (provider vocabulary may grow); decisions use `sender_authenticated` + `basis`.
 */
export const EmailAuth = z.object({
  /** `email.analysis.sender.authenticated` — true only when Primitive authenticated the From address. */
  sender_authenticated: z.boolean(),
  basis: z.enum(["dmarc_aligned", "google_provider_attested", "spf_aligned", "unauthenticated"]),
  reasons: z.array(z.string().max(300)).max(20).default([]),
  spf: z.string().max(40).nullable(),
  dmarc: z.string().max(40).nullable(),
  /** Domains with a passing, aligned DKIM signature. */
  dkim_aligned_domains: z.array(z.string().max(253)).max(20).default([]),
});
export type EmailAuth = z.infer<typeof EmailAuth>;

export const AttachmentRef = z.object({
  filename: z.string().max(255),
  content_type: z.string().max(255),
  size_bytes: z.number().int().nonnegative(),
  /** Provider reference used to fetch bytes; never trusted as a URL to follow blindly. */
  provider_ref: z.string().max(1000).optional(),
  /** Local storage key once downloaded. */
  storage_key: z.string().max(500).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

export const EmailMessage = z.object({
  id: MessageId,
  job_id: JobId.nullable(), // null while quarantined
  seller_id: SellerId.nullable(),
  direction: z.enum(["inbound", "outbound"]),
  /** Provider's message identifier — unique; the dedup key for webhooks. */
  provider_message_id: z.string().max(500),
  /** RFC 5322 Message-ID header. */
  rfc_message_id: z.string().max(998).optional(),
  in_reply_to: z.string().max(998).optional(),
  references: z.array(z.string().max(998)).default([]),
  from: EmailAddress,
  to: z.array(EmailAddress).min(1),
  subject: z.string().max(998),
  text: z.string().max(200_000).optional(),
  html: z.string().max(500_000).optional(),
  attachments: z.array(AttachmentRef).default([]),
  auth: EmailAuth.optional(), // inbound only
  kind: z.enum([
    "rfq",
    "follow_up",
    "counteroffer",
    "answer",
    "decline",
    "approval_request",
    "payment",
    "seller_reply",
    "approver_reply",
    "payment_challenge",
    "payment_receipt",
    "unknown",
  ]),
  /** Why an inbound message could not be attached to a job, if quarantined. */
  quarantine_reason: z.string().max(500).optional(),
  received_at: IsoDateTime,
});
export type EmailMessage = z.infer<typeof EmailMessage>;

// ---------------------------------------------------------------- Quotes

export const LineItem = z.object({
  description: z.string().max(300),
  quantity: z.number().int().nonnegative().optional(),
  unit_price_cents: Cents.optional(),
  total_cents: Cents.optional(),
  /** Tags that requirement checks can count, e.g. ["vegetarian"]. */
  tags: z.array(z.string().max(40)).max(10).default([]),
  provenance: Provenance,
});
export type LineItem = z.infer<typeof LineItem>;

export const Fee = z.object({
  label: z.string().max(120),
  amount_cents: Cents,
  provenance: Provenance,
});
export type Fee = z.infer<typeof Fee>;

export const QuoteFlag = z.object({
  code: z.enum([
    "requirement_unmet",
    "requirement_unknown",
    "over_budget",
    "missing_total",
    "missing_delivery_terms",
    "tax_excluded",
    "hidden_fee",
    "deposit_required",
    "conflicting_numbers",
    "low_confidence",
    "expired",
    "malformed_structured_part",
    "suspicious_payment_request",
    "prompt_injection",
    "unverified_sender",
    "vague_pricing",
  ]),
  severity: z.enum(["info", "warning", "blocking"]),
  detail: z.string().max(300),
  provenance: Provenance.optional(),
});
export type QuoteFlag = z.infer<typeof QuoteFlag>;

export const Quote = z.object({
  id: QuoteId,
  job_id: JobId,
  seller_id: SellerId,
  /** Monotonic per (job, seller); a revision supersedes earlier revisions. */
  revision: z.number().int().positive(),
  supersedes: QuoteId.optional(),
  status: z.enum(["current", "superseded", "expired", "withdrawn"]),
  source_message_id: MessageId,
  source: z.enum(["quote_json", "email_text", "email_html", "pdf_attachment", "mixed"]),
  seller_kind: SellerKind,
  line_items: z.array(LineItem).max(100),
  subtotal: evidenced(Cents),
  delivery_fee: evidenced(Cents),
  tax: evidenced(Cents),
  /** Whether stated tax is included in the stated total. */
  tax_included: evidenced(z.boolean()),
  fees: z.array(Fee).max(20),
  /** All-in amount the buyer would pay. Missing if any critical component is unknown. */
  total: evidenced(Cents),
  deposit: evidenced(NonNegativeCents),
  per_unit: evidenced(Cents),
  delivery_included: evidenced(z.boolean()),
  fulfillment_date: evidenced(z.string()),
  valid_until: evidenced(IsoDateTime),
  payment_terms: evidenced(z.string().max(500)),
  requirement_checks: z.array(RequirementCheck),
  meets_requirements: z.enum(["yes", "no", "unknown"]),
  flags: z.array(QuoteFlag).max(30),
  /** Overall extraction confidence 0..1 (not seller trustworthiness). */
  confidence: z.number().min(0).max(1),
  negotiated_from_cents: Cents.optional(),
  negotiation_round: z.number().int().nonnegative(),
  created_at: IsoDateTime,
});
export type Quote = z.infer<typeof Quote>;

// ---------------------------------------------------------------- Questions & negotiation

export const SellerQuestion = z.object({
  id: QuestionId,
  job_id: JobId,
  seller_id: SellerId,
  source_message_id: MessageId,
  /** Verbatim question text as extracted from the seller's email (untrusted). */
  question: z.string().max(2000),
  status: z.enum(["open", "auto_answered", "answered", "escalated", "dismissed"]),
  answer: z.string().max(2000).optional(),
  answered_by: z.enum(["haggle_from_job_context", "buyer_agent"]).optional(),
  answer_message_id: MessageId.optional(),
  created_at: IsoDateTime,
  answered_at: IsoDateTime.optional(),
});
export type SellerQuestion = z.infer<typeof SellerQuestion>;

export const NegotiationRound = z.object({
  id: RoundId,
  job_id: JobId,
  seller_id: SellerId,
  round: z.number().int().positive(),
  kind: z.enum(["clarification_request", "counteroffer", "seller_counter", "accepted", "declined"]),
  /** Our ask, when we counter. Must be backed by a real competing quote. */
  target_total_cents: Cents.optional(),
  /** The competing quote that justifies the target, if any (never fabricated). */
  basis_quote_id: QuoteId.optional(),
  basis_summary: z.string().max(300).optional(),
  outbound_message_id: MessageId.optional(),
  response_message_id: MessageId.optional(),
  respond_by: IsoDateTime.optional(),
  outcome: z.enum(["pending", "improved", "unchanged", "declined", "expired"]),
  created_at: IsoDateTime,
});
export type NegotiationRound = z.infer<typeof NegotiationRound>;

// ---------------------------------------------------------------- Approval

/**
 * An approval binds a human decision to an exact (job, seller, quote revision,
 * amount) tuple. Any change to those invalidates it.
 */
export const ApprovalRequest = z.object({
  id: ApprovalId,
  job_id: JobId,
  quote_id: QuoteId,
  seller_id: SellerId,
  quote_revision: z.number().int().positive(),
  /** Full quoted total (what the human is agreeing to buy). */
  quoted_total_cents: NonNegativeCents,
  /** Maximum that may be paid now (the deposit, or the total if no deposit). */
  max_payment_cents: NonNegativeCents,
  channel: z.enum(["elicitation", "email"]),
  approver_email: EmailAddress,
  /** Random one-time token embedded in the approval email; hashed at rest. */
  nonce_hash: z.string().optional(),
  approval_message_id: MessageId.optional(),
  status: z.enum(["pending", "approved", "declined", "expired", "invalidated"]),
  expires_at: IsoDateTime,
  created_at: IsoDateTime,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const ApprovalRecord = z.object({
  id: ApprovalId,
  request_id: ApprovalId,
  job_id: JobId,
  quote_id: QuoteId,
  seller_id: SellerId,
  quote_revision: z.number().int().positive(),
  approved_max_cents: NonNegativeCents,
  decision: z.enum(["approved", "declined"]),
  channel: z.enum(["elicitation", "email"]),
  /** Who approved: verified email address, or the host-asserted identity for elicitation. */
  approver: z.string().max(320),
  /** Evidence: e.g. the verified inbound message id, or the elicitation response id. */
  evidence: z.object({
    message_id: MessageId.optional(),
    sender_verified: z.boolean().optional(),
    elicitation_action: z.enum(["accept", "decline", "cancel"]).optional(),
    note: z.string().max(500).optional(),
  }),
  consumed_at: IsoDateTime.optional(),
  decided_at: IsoDateTime,
});
export type ApprovalRecord = z.infer<typeof ApprovalRecord>;

// ---------------------------------------------------------------- Payment

export const PaymentNetwork = z.enum(["base-sepolia"]); // testnet only, by construction
export type PaymentNetwork = z.infer<typeof PaymentNetwork>;

export const PaymentChallenge = z.object({
  id: ChallengeId,
  job_id: JobId,
  seller_id: SellerId,
  source_message_id: MessageId,
  /** Primitive x402 interaction id, '<uuid>@<payee-domain>'. */
  interaction_id: z.string().max(500),
  /** The challenge step id; (interaction_id, challenge_step_id) is unique. */
  challenge_step_id: z.string().max(200),
  payee_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  /** Email identity that issued the challenge (must be the quoting seller). */
  issuer_email: EmailAddress,
  issuer_authenticated: z.boolean(),
  network: z.string(), // stored raw; validated against PaymentNetwork at pay time
  amount_base_units: UsdcBaseUnits,
  asset: z.string().max(100),
  expires_at: IsoDateTime.optional(),
  status: z.enum(["received", "held", "consumed", "rejected", "expired"]),
  rejection_reason: z.string().max(500).optional(),
  /** Raw interaction payload kept verbatim for audit. */
  raw: z.unknown(),
  received_at: IsoDateTime,
});
export type PaymentChallenge = z.infer<typeof PaymentChallenge>;

export const PaymentAttempt = z.object({
  id: PaymentId,
  job_id: JobId,
  challenge_id: ChallengeId,
  approval_id: ApprovalId,
  amount_base_units: UsdcBaseUnits,
  /** Idempotency key: one attempt per challenge, enforced by a unique constraint. */
  idempotency_key: z.string().max(200),
  status: z.enum(["signing", "submitted", "settled", "failed"]),
  gateway: z.enum(["primitive_x402", "fake"]),
  failure_reason: z.string().max(500).optional(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type PaymentAttempt = z.infer<typeof PaymentAttempt>;

export const PaymentReceipt = z.object({
  payment_id: PaymentId,
  job_id: JobId,
  network: z.string(),
  settle_tx: z.string().max(200),
  explorer_url: z.url().optional(),
  amount_base_units: UsdcBaseUnits,
  /** True only for receipts from a real settlement rail. Fake receipts are always false. */
  real_settlement: z.boolean(),
  source_message_id: MessageId.optional(),
  settled_at: IsoDateTime,
});
export type PaymentReceipt = z.infer<typeof PaymentReceipt>;

// ---------------------------------------------------------------- Audit

export const AuditEvent = z.object({
  id: EventId,
  job_id: JobId.nullable(),
  /** Monotonic per job; the cursor for wait_for_update. */
  seq: z.number().int().nonnegative(),
  type: z.string().regex(/^[a-z_]+\.[a-z_]+$/), // e.g. "quote.received"
  actor: z.enum(["buyer_agent", "human", "seller", "haggle", "system"]),
  summary: z.string().max(300),
  data: z.record(z.string(), z.unknown()).default({}),
  at: IsoDateTime,
});
export type AuditEvent = z.infer<typeof AuditEvent>;
