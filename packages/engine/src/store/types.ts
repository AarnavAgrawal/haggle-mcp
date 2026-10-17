// Engine persistence: row shapes and the repository port. Mirrors
// supabase/migrations/100_engine_core.sql. Money is integer cents; USDC is base-unit strings.
//
// Shape follows quote-broker@8a68559 src/db/schema.sql + queries.ts (jobs/vendors/messages/quotes/
// approvals/payments/job_events/webhook_events), adapted to v3: businesses are per-job snapshots
// keyed by the contract's deterministic business_id (no FK to brain tables), questions are rows,
// payments are x402 state, and events carry a gap-free per-job seq used as the wait cursor.
import type { JobState, Request } from "../contract.ts";
import type { QuoteRecord } from "../parsing/extraction.ts";
import type { RequirementResult } from "../parsing/requirements.ts";

export type Mode = "mock" | "live";

export interface JobRow {
  id: string;
  short_code: string;
  state: JobState;
  mode: Mode;
  request: Request;
  budget_cents: number | null;
  payment_cap_cents: number;
  approver_email: string | null;
  inbox: string;
  round: number;
  max_rounds: number;
  collect_until: string; // ISO; reply-by for the current round
  /** Collection/negotiation finished and a recommendation can be approved. */
  ready: boolean;
  pay_intent: boolean;
  failure_reason: string | null;
  client_request_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export type BusinessStatus =
  | "pending" | "contacted" | "replied" | "quoted" | "question" | "declined" | "bounced" | "silent"
  // v5 channels: a placed call is "ringing" until call.ended; "no_reply" = call not answered;
  // "unavailable" = the business's only channel isn't enabled in this deployment (never contacted).
  | "ringing" | "no_reply" | "unavailable";

/** v5 channel a business is reached on. Email is live; phone/A2A are simulated in mock mode only. */
export type Channel = "email" | "phone" | "a2a" | "imessage";

export interface JobBusinessRow {
  job_id: string;
  business_id: string;
  name: string; // snapshot
  email: string | null; // snapshot, lowercased; the only address Haggle ever sends to or trusts for this job
  phone: string | null; // snapshot, E.164; the only number Haggle ever calls for this job
  a2a_card_url: string | null;
  channel: Channel; // chosen at deal time (A2A card > email > phone)
  source: "fleet" | "web" | "agent";
  simulated: boolean;
  status: BusinessStatus;
  thread_id: string | null;
  rfq_message_id: string | null; // RFC Message-ID of our RFQ
  last_inbound_message_id: string | null; // RFC Message-ID of their latest email (for In-Reply-To)
  references: string[];
  contacted_at: string | null;
  last_reply_at: string | null;
  followups_sent: number;
  countered_round: number; // last round we sent a counteroffer for (0 = none)
}

export type MessageKind =
  | "rfq" | "reply" | "followup" | "answer" | "counter" | "approval_request" | "approval_reply"
  | "accept" | "payment" | "receipt" | "cancel" | "quarantine" | "call";

export interface StoredAttachment {
  filename: string | null;
  content_type: string;
  size_bytes: number;
  tar_path: string | null;
  /** Inline bytes for small JSON parts and simulated messages (base64). Never PDFs from live mail. */
  content_base64?: string;
}

export interface MessageRow {
  id: string;
  job_id: string | null;
  business_id: string | null;
  approval_id: string | null;
  direction: "in" | "out";
  kind: MessageKind;
  provider_email_id: string | null; // unique: inbound dedupe / outbound send id
  idempotency_key: string | null; // unique for outbound
  rfc_message_id: string | null;
  thread_id: string | null;
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  body_text: string | null;
  attachments: StoredAttachment[];
  attachments_download_url: string | null;
  sender_trusted: boolean | null;
  trust_reason: string | null;
  matched_via: string | null;
  parse_status: "none" | "pending" | "done" | "failed";
  quarantine_reason: string | null;
  round: number | null;
  simulated: boolean;
  /** Channel the message travelled on; phone rows hold a call transcript in body_text. */
  channel: Channel;
  created_at: string;
}

export interface QuoteRow {
  id: string;
  job_id: string;
  business_id: string;
  message_id: string; // unique: one quote per inbound message
  round: number;
  status: "current" | "superseded" | "expired" | "withdrawn";
  record: QuoteRecord;
  total_cents: number | null;
  deposit_cents: number | null;
  compliant: boolean;
  requirement_results: RequirementResult[];
  sender_trusted: boolean;
  source: string; // "quote.json" | "pdf p.2" | "email body"
  created_at: string;
}

export interface QuestionRow {
  id: string;
  job_id: string;
  business_id: string;
  message_id: string;
  text: string;
  status: "pending" | "answered";
  answer: string | null;
  answered_at: string | null;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  job_id: string;
  quote_id: string;
  business_id: string;
  quote_total_cents: number;
  payment_cents: number;
  cap_cents: number;
  approver: string | null;
  channel: "elicitation" | "email" | "simulated" | "view" | "imessage";
  status: "pending" | "approved" | "declined" | "expired" | "used";
  code: string;
  expires_at: string;
  decided_at: string | null;
  outbound_message_id: string | null; // RFC Message-ID of the approval request email
  thread_id: string | null;
  created_at: string;
}

export interface PaymentRow {
  id: string;
  job_id: string;
  approval_id: string; // unique: one payment per approval
  business_id: string;
  /** x402: awaiting_invoice → invoice_received → signed → sent → settled. Stripe: charging → settled | failed. */
  status: "awaiting_invoice" | "invoice_received" | "signed" | "sent" | "settled" | "rejected" | "expired" | "failed" | "charging";
  /** v5: "stripe" (test mode) or the v3 "x402" rail (migration 102). */
  rail: "x402" | "stripe";
  amount_cents: number;
  amount_base_units: string; // x402: USDC base units; stripe: cents
  network: "base-sepolia" | "stripe-test";
  /** Stripe: the key sent with every charge attempt for this approval (never reused for another). */
  idempotency_key: string | null;
  stripe_payment_intent_id: string | null;
  challenge_json: string | null; // the business's interaction.json challenge
  challenge_step_id: string | null; // unique
  challenge_message_id: string | null;
  challenge_trusted: boolean;
  challenge_thread_matched: boolean;
  pay_to: string | null;
  interaction_json: string | null; // our signed payment step (canonical bytes), kept to resend identically
  settle_tx: string | null;
  simulated: boolean;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobEventRow {
  job_id: string;
  seq: number; // gap-free per job, starts at 1
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export type NewMessage = Omit<MessageRow, "id" | "created_at" | "channel"> & { channel?: Channel };

/** Buyer settings (ChatGPT native settings / settings tools). Never changed by business messages. */
export interface SettingsRow {
  spending_cap_cents: number; // per-job order cap used when deal() has no budget_usd
  approver_phone: string | null; // E.164; iMessage approver (9 PM gate)
  approver_email: string | null;
  default_area: string | null;
  updated_at: string;
}

/** Persistence port. InMemoryRepository for tests/mock mode; PostgresRepository for live. */
export interface Repository {
  // jobs
  insertJob(job: JobRow): Promise<JobRow>;
  getJob(id: string): Promise<JobRow | null>;
  findJobByClientRequestId(id: string): Promise<JobRow | null>;
  findJobByShortCode(code: string): Promise<JobRow | null>;
  /** Compare-and-swap on version; returns the new row or null if someone else won. */
  casJob(id: string, expectedVersion: number, patch: Partial<JobRow>): Promise<JobRow | null>;
  /** Unconditional version bump (wakes waiters) with an optional patch. */
  touchJob(id: string, patch?: Partial<JobRow>): Promise<JobRow | null>;
  listOpenJobs(): Promise<JobRow[]>;

  // businesses
  insertBusinesses(rows: JobBusinessRow[]): Promise<void>;
  getBusinesses(jobId: string): Promise<JobBusinessRow[]>;
  /** `ifStatus`: apply only while the row's status is one of these (atomic; no stale-read overwrite). */
  updateBusiness(jobId: string, businessId: string, patch: Partial<JobBusinessRow>, opts?: { ifStatus?: JobBusinessRow["status"][] }): Promise<void>;
  /** Candidates for matching an inbound email: by job short codes, thread id, or our Message-IDs. */
  findBusinessCandidates(q: { shortCodes: string[]; threadId: string | null; messageIds: string[] }): Promise<(JobBusinessRow & { short_code: string })[]>;

  // messages
  /** Idempotent: returns null when provider_email_id or idempotency_key already exists. */
  insertMessage(m: NewMessage): Promise<MessageRow | null>;
  findMessageByIdempotencyKey(key: string): Promise<MessageRow | null>;
  /** Inbound dedupe key / outbound provider send id (e.g. an Inkbox call id). */
  findMessageByProviderId(providerId: string): Promise<MessageRow | null>;
  getMessage(id: string): Promise<MessageRow | null>;
  updateMessage(id: string, patch: Partial<MessageRow>): Promise<void>;
  listMessages(jobId: string): Promise<MessageRow[]>;
  getPendingMessages(jobId: string): Promise<MessageRow[]>;
  findOutboundByRfcIds(ids: string[]): Promise<MessageRow[]>;

  // quotes
  /** Inserts as current and supersedes the business's previous current quote, atomically. Null if message already parsed. */
  insertCurrentQuote(q: Omit<QuoteRow, "id" | "created_at" | "status">): Promise<QuoteRow | null>;
  getQuote(id: string): Promise<QuoteRow | null>;
  listQuotes(jobId: string): Promise<QuoteRow[]>;

  // questions
  insertQuestion(q: Omit<QuestionRow, "id" | "created_at" | "status" | "answer" | "answered_at">): Promise<QuestionRow>;
  getQuestion(id: string): Promise<QuestionRow | null>;
  listQuestions(jobId: string): Promise<QuestionRow[]>;
  /** CAS pending -> answered; false if already answered. */
  answerQuestion(id: string, answer: string): Promise<boolean>;

  // approvals
  insertApproval(a: Omit<ApprovalRow, "created_at">): Promise<ApprovalRow | null>; // null if one is already pending for the job
  getApproval(id: string): Promise<ApprovalRow | null>;
  getLatestApproval(jobId: string): Promise<ApprovalRow | null>;
  listPendingApprovalCandidates(q: { shortCodes: string[]; threadId: string | null; messageIds: string[] }): Promise<(ApprovalRow & { short_code: string; approver_email: string })[]>;
  /** Pending approvals on one human channel (e.g. iMessage), across jobs. */
  listPendingApprovalsByChannel(channel: ApprovalRow["channel"]): Promise<ApprovalRow[]>;
  /** CAS on status. */
  transitionApproval(id: string, from: ApprovalRow["status"], patch: Partial<ApprovalRow>): Promise<boolean>;
  updateApproval(id: string, patch: Partial<ApprovalRow>): Promise<void>;

  // payments
  insertPayment(p: Omit<PaymentRow, "created_at" | "updated_at">): Promise<PaymentRow | null>; // null if approval already has one
  getPaymentForJob(jobId: string): Promise<PaymentRow | null>;
  /** CAS on status. */
  transitionPayment(id: string, from: PaymentRow["status"][], patch: Partial<PaymentRow>): Promise<PaymentRow | null>;

  // events + dedupe
  appendEvent(jobId: string, type: string, data?: Record<string, unknown>): Promise<JobEventRow>;
  listEvents(jobId: string, afterSeq?: number): Promise<JobEventRow[]>;
  /** True the first time an event id is seen. */
  recordInboundEvent(providerEventId: string): Promise<boolean>;

  // jobs (launcher) + settings
  /** Most recently updated jobs, newest first. */
  listRecentJobs(limit: number): Promise<JobRow[]>;
  getSettings(): Promise<SettingsRow | null>;
  saveSettings(s: Omit<SettingsRow, "updated_at">): Promise<SettingsRow>;
}
