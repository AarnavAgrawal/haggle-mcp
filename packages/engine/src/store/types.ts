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

/** The workspace every job belongs to when a server runs single-tenant (no workspace tokens). */
export const DEFAULT_WORKSPACE_ID = "ws_default";

/**
 * A tenant: one buyer (agent + human approver). Jobs, settings and approvals are scoped to it; an
 * MCP connection is bound to one workspace by its bearer token or connector secret (stored only as
 * SHA-256 hashes). Ported from haggle-testing src/comms/workspace.ts; the Inkbox buyer identity
 * stays shared (one `haggle` mailbox), replies are still matched by thread and [HG-code].
 */
export interface WorkspaceRow {
  id: string;
  name: string;
  token_hash: string | null;
  connector_secret_hash: string | null;
  /** IANA timezone for call hours, e.g. "America/Los_Angeles". */
  timezone: string;
  /** Set when the operator revoked the workspace: its credentials no longer resolve (migration 105). */
  revoked_at?: string | null;
  created_at: string;
}

export interface JobRow {
  id: string;
  /** Owning workspace (DEFAULT_WORKSPACE_ID on single-tenant servers). */
  workspace_id: string;
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
  /** Failed attempts to send the RFQ on the current channel (retryable provider errors). */
  send_attempts: number;
  /** When a retry (or a call deferred to call hours) is due; null = nothing scheduled. */
  next_attempt_at: string | null;
  /** When Haggle escalated this business from email to a Voice AI call (null = never). */
  escalated_at: string | null;
}

export type MessageKind =
  | "rfq" | "reply" | "followup" | "answer" | "counter" | "approval_request" | "approval_reply"
  | "accept" | "payment" | "receipt" | "cancel" | "quarantine" | "call"
  // v5 parity: the agent's own (guarded) message to a business, and the post-approval confirmation.
  | "message" | "confirmation";

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
  /** locked = too many wrong codes (MAX approval attempts); it can't be approved any more. */
  status: "pending" | "approved" | "declined" | "expired" | "used" | "locked";
  /** What the human approves; confirm-only approvals have payment_cents 0. */
  action: "confirm" | "pay" | "confirm_and_pay";
  /** Wrong codes entered so far (approval card or iMessage). */
  attempts: number;
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
  // workspaces (tenancy)
  insertWorkspace(w: Omit<WorkspaceRow, "created_at">): Promise<WorkspaceRow>;
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  findWorkspaceByTokenHash(hash: string): Promise<WorkspaceRow | null>;
  findWorkspaceBySecretHash(hash: string): Promise<WorkspaceRow | null>;
  /** Revoke (credentials stop resolving) or rotate (new hashes, revocation cleared) a workspace's credentials. */
  setWorkspaceCredentials(id: string, c: { token_hash?: string | null; connector_secret_hash?: string | null; revoked: boolean }): Promise<WorkspaceRow | null>;

  // jobs
  insertJob(job: JobRow): Promise<JobRow>;
  getJob(id: string): Promise<JobRow | null>;
  /** client_request_id is unique per workspace. */
  findJobByClientRequestId(id: string, workspaceId?: string): Promise<JobRow | null>;
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
  /** Every message with this business across all jobs (contact-performance learning). */
  listMessagesForBusiness(businessId: string): Promise<MessageRow[]>;
  /** Every job row that addressed this email or phone (any job), for identity aliases. */
  listJobBusinessesByContact(c: { email?: string | null; phone?: string | null }): Promise<JobBusinessRow[]>;
  getPendingMessages(jobId: string): Promise<MessageRow[]>;
  findOutboundByRfcIds(ids: string[]): Promise<MessageRow[]>;
  /** Calls to or from one number since a time, across jobs (call cooldown; a call in progress). */
  listPhoneMessages(number: string, sinceIso: string): Promise<MessageRow[]>;

  // quotes
  /** Inserts as current and supersedes the business's previous current quote, atomically. Null if message already parsed. */
  insertCurrentQuote(q: Omit<QuoteRow, "id" | "created_at" | "status">): Promise<QuoteRow | null>;
  getQuote(id: string): Promise<QuoteRow | null>;
  listQuotes(jobId: string): Promise<QuoteRow[]>;
  /** Every quote from this business across all jobs. */
  listQuotesForBusiness(businessId: string): Promise<QuoteRow[]>;

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
  /**
   * One wrong code, atomically: attempts + 1 on a pending approval, and status -> locked once
   * attempts reach maxAttempts. Returns the new count (null if the approval isn't pending).
   */
  recordWrongApprovalCode(id: string, maxAttempts: number): Promise<{ attempts: number; locked: boolean } | null>;

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

  // jobs (launcher) + settings (per workspace)
  /** Most recently updated jobs, newest first; only the workspace's when given. */
  listRecentJobs(limit: number, workspaceId?: string): Promise<JobRow[]>;
  getSettings(workspaceId?: string): Promise<SettingsRow | null>;
  saveSettings(s: Omit<SettingsRow, "updated_at">, workspaceId?: string): Promise<SettingsRow>;
}
