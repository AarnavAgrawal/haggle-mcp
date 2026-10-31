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
import type { WeeklyHours } from "../reputation/hours.ts";

export type Mode = "mock" | "live";

/** The workspace every job belongs to when a server runs single-tenant (no workspace tokens). */
export const DEFAULT_WORKSPACE_ID = "ws_default";

/**
 * The brain's sentinel for profiles learned before tenancy (supabase/migrations/202_brain_tenancy.sql;
 * @haggle/brain's LEGACY_POOLED_WORKSPACE_ID): pooled from every workspace's deals, so no workspace
 * may ever have this id. createWorkspace (and every path through it) and workspace-create refuse it.
 */
export const LEGACY_POOLED_WORKSPACE_ID = "ws_legacy_pooled";
/** Workspace ids no workspace can be created with. */
export const RESERVED_WORKSPACE_IDS: readonly string[] = [LEGACY_POOLED_WORKSPACE_ID];

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
  /** Its published weekly opening hours (listing, else website; migration 125); absent/null = unknown. */
  opening_hours?: WeeklyHours | null;
  /** Its IANA timezone, when known (migration 125). */
  timezone?: string | null;
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
  /** Outbound email only (migration 112): Inkbox reported it bounced or failed after accepting it. Absent/null = no report. */
  delivery_status?: "bounced" | "failed" | null;
  delivery_status_at?: string | null;
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
  /** "web": the signed-in account owner in the Haggle web app (service routes only, never an MCP tool; migration 123). */
  channel: "elicitation" | "email" | "simulated" | "view" | "imessage" | "web";
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

/** One outbound action, claimed before the provider is called (migration 106). */
export interface OutboxRow {
  key: string;
  job_id: string | null;
  /** "call" has no provider idempotency: once claimed it is never claimed again unless known not placed. */
  kind: "email" | "text" | "call" | "a2a";
  status: "pending" | "sent" | "not_sent" | "unknown";
  provider_ref: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

/** An address or number Haggle never contacts again (an opt-out, or a hard bounce). */
export interface SuppressionRow {
  contact: string;
  reason: "opt_out" | "bounce";
  job_id: string | null;
  evidence: string | null;
  created_at: string;
}

/** A vendor the operator authorized for one workspace, and the consent that rests on. */
export interface WorkspaceVendorRow {
  workspace_id: string;
  contact: string;
  name: string;
  consent: string;
  added_by: string;
  /** How the vendor is reached (migration 108); null = by its contact (email, else a call). */
  channel?: Channel | null;
  /** Its published opening hours and timezone, from the listing it was added from (migration 125). */
  opening_hours?: WeeklyHours | null;
  timezone?: string | null;
  /** The public listing it was added from ("aws:<PlaceId>", "place:<id>"), if any (migration 125). */
  business_ref?: string | null;
  created_at: string;
}

/**
 * Manual payment handoff: the human pays the business directly (no money moves through Haggle).
 * Haggle records the business's payment instructions (untrusted text, never followed) and the
 * human's own confirmation that they paid; only then does the business hear that payment was sent.
 */
export interface PaymentHandoffRow {
  id: string;
  job_id: string;
  approval_id: string;
  business_id: string;
  amount_cents: number;
  status: "instructions_requested" | "instructions_received" | "human_confirmed" | "cancelled";
  instructions_text: string | null;
  instructions_message_id: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  /** When the business's instructions were overdue and the human and operator were told (migration 110). */
  stalled_at?: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What Haggle last texted a remote number from one of its lines, for one job and purpose (migration
 * 108): a text back from that number answers it. Durable, so a restart or another replica routes the
 * reply to the same job and workspace. `line` is Haggle's own number (or "default" when unknown).
 */
export interface TextRouteRow {
  line: string;
  remote: string;
  workspace_id: string;
  job_id: string;
  purpose: "human" | "business";
  business_id: string | null;
  question_id: string | null;
  approval_id: string | null;
  last_out_at: string;
}

/** A text to the human refused while Inkbox paused the number; re-sent when it texts back. */
export interface HeldTextRow {
  line: string;
  remote: string;
  key: string;
  workspace_id: string;
  job_id: string;
  text: string;
  question_id: string | null;
  approval_id: string | null;
  held_at: string;
}

/** The operator removed a suppression (a wrong opt-out or bounce): who, why, and what it was. */
export interface SuppressionRemovalRow {
  contact: string;
  reason: SuppressionRow["reason"];
  job_id: string | null;
  evidence: string | null;
  suppressed_at: string;
  removed_by: string;
  why: string;
  removed_at: string;
}

/**
 * The operator's dead-letter queue (migration 109): something Haggle stopped retrying (or must
 * never retry on its own) and a person has to look at. One open row per (kind, subject).
 */
export interface OperatorReviewRow {
  id: string;
  job_id: string | null;
  kind: "outbox" | "payment" | "reconcile" | "parse" | "stuck_job" | "late_reply" | "confirmation";
  /** What it is about: an outbox key, a payment id, a message id, a job id. */
  subject: string;
  reason: string;
  attempts: number;
  /** Redacted (workflow/deadLetter.ts redactError). */
  last_error: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The booking after the human's approval (migration 110): the business must explicitly confirm
 * availability and the approved terms before the deal counts as booked and the payment handoff
 * starts. "not_in_writing": a business Haggle can't get a written answer from (a phone or A2A
 * business); the human confirms with it directly. Its reply is untrusted text, shown, never followed.
 */
export interface BookingRow {
  id: string;
  job_id: string;
  approval_id: string;
  quote_id: string;
  business_id: string;
  total_cents: number;
  payment_cents: number;
  status: "awaiting_vendor_confirmation" | "confirmed" | "not_in_writing" | "declined" | "changed" | "cancelled";
  request_message_id: string | null;
  reply_text: string | null;
  reply_message_id: string | null;
  reply_has_link: boolean;
  confirmed_at: string | null;
  stalled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
  /**
   * A not_in_writing booking the approver confirmed with the business directly and accepted by text
   * (BOOKED <code>; migration 118). No payment handoff starts before it. Absent on stores before 118.
   */
  human_attested_at?: string | null;
}

/** The business's explicit "payment received" (verified sender) after the customer reported paying. */
export interface HandoffReceiptRow {
  id: string;
  handoff_id: string;
  job_id: string;
  message_id: string;
  evidence: string;
  created_at: string;
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

  // job leases (one advancing instance per job, across processes)
  /** Take or renew the lease when it is free, expired or already ours. False: another instance holds it. */
  acquireJobLease(jobId: string, owner: string, now: string, ttlMs: number): Promise<boolean>;
  releaseJobLease(jobId: string, owner: string): Promise<void>;

  // outbox
  /** Insert a pending claim; `fresh` false = the key was already claimed (row is the existing one). */
  claimOutbox(o: { key: string; job_id: string | null; kind: OutboxRow["kind"] }, now: string): Promise<{ fresh: boolean; row: OutboxRow }>;
  /** Re-claim a stale idempotent action (same provider key) or one known not sent. Null if refused. */
  reclaimOutbox(key: string, fromStatuses: OutboxRow["status"][], now: string): Promise<OutboxRow | null>;
  finishOutbox(key: string, status: Exclude<OutboxRow["status"], "pending">, providerRef: string | null, now: string): Promise<void>;
  getOutbox(key: string): Promise<OutboxRow | null>;

  // suppressions (global: one buyer identity contacts every vendor)
  addSuppression(s: Omit<SuppressionRow, "created_at">): Promise<void>;
  findSuppressions(contacts: string[]): Promise<SuppressionRow[]>;

  // per-workspace vendor authorization
  addWorkspaceVendor(v: Omit<WorkspaceVendorRow, "created_at">): Promise<WorkspaceVendorRow>;
  removeWorkspaceVendor(workspaceId: string, contact: string): Promise<boolean>;
  listWorkspaceVendors(workspaceId: string): Promise<WorkspaceVendorRow[]>;

  // manual payment handoff
  insertHandoff(h: Omit<PaymentHandoffRow, "created_at" | "updated_at">): Promise<PaymentHandoffRow | null>;
  getHandoffByApproval(approvalId: string): Promise<PaymentHandoffRow | null>;
  updateHandoff(id: string, fromStatuses: PaymentHandoffRow["status"][], patch: Partial<Pick<PaymentHandoffRow, "status" | "instructions_text" | "instructions_message_id" | "confirmed_by" | "confirmed_at">>): Promise<PaymentHandoffRow | null>;

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

  // text routing (migration 108; workspace-scoped, durable across restarts and replicas)
  /** Upsert the route for (line, remote, job, purpose) with these ids and time. */
  recordTextRoute(r: TextRouteRow): Promise<void>;
  /** Every route to a remote number on one line, newest first. */
  listTextRoutes(line: string, remote: string): Promise<TextRouteRow[]>;
  /** Hold a text (replacing one with the same key), keeping only the newest `keep` for the number. */
  holdText(h: Omit<HeldTextRow, "held_at">, keep: number): Promise<void>;
  /** Remove and return a number's held texts, oldest first (atomic: one taker). */
  takeHeldTexts(line: string, remote: string): Promise<HeldTextRow[]>;
  isApprovalHeld(approvalId: string): Promise<boolean>;
  /** Operator only: delete a suppression and record who removed it and why (atomic). Null if none. */
  removeSuppression(contact: string, removedBy: string, why: string): Promise<SuppressionRemovalRow | null>;
  /** Workspaces whose settings approver is this phone (routing a text from it must not guess between them). */
  listWorkspacesByApproverPhone(phone: string): Promise<string[]>;
  // reliability (migration 109): lease fencing, outbox inspection, operator review (dead letters)
  /** Extend the lease only while this exact owner still holds it (the fence). False: it was lost. */
  renewJobLease(jobId: string, owner: string, now: string, ttlMs: number): Promise<boolean>;
  listOutbox(q: { jobId?: string; statuses?: OutboxRow["status"][]; updatedBefore?: string; limit?: number }): Promise<OutboxRow[]>;
  findOutboxByProviderRef(ref: string): Promise<OutboxRow | null>;
  /**
   * Operator retry: back to not_sent with a fresh attempt count, so the engine's next natural attempt
   * may claim it. Refused (null) for a sent action, and for a call unless it is known not placed.
   */
  rearmOutbox(key: string, now: string): Promise<OutboxRow | null>;
  /** Open a review, or update the open one for the same kind and subject (attempts, reason, last error). */
  openReview(r: Pick<OperatorReviewRow, "id" | "job_id" | "kind" | "subject" | "reason" | "attempts" | "last_error">, now: string): Promise<{ row: OperatorReviewRow; created: boolean }>;
  findOpenReview(kind: OperatorReviewRow["kind"], subject: string): Promise<OperatorReviewRow | null>;
  getReview(id: string): Promise<OperatorReviewRow | null>;
  /** Newest first. */
  listReviews(q: { status?: OperatorReviewRow["status"]; jobId?: string; limit?: number }): Promise<OperatorReviewRow[]>;
  /** CAS open -> resolved; null if it isn't open. */
  resolveReview(id: string, r: { resolution: string; resolved_by: string }, now: string): Promise<OperatorReviewRow | null>;
  // ops (migration 111; optional: in-memory and test repositories have no ledger)
  /** The migration ledger rows; null when engine_migrations doesn't exist yet. Read-only. */
  listAppliedMigrations?(): Promise<{ name: string; checksum: string | null; applied_at: string }[] | null>;
  // bookings and verified receipts (migration 110), appended
  /** Null when the approval already has a booking. */
  insertBooking(b: Omit<BookingRow, "created_at" | "updated_at">): Promise<BookingRow | null>;
  getBookingByApproval(approvalId: string): Promise<BookingRow | null>;
  /** CAS on status; null when the booking isn't in one of `fromStatuses`. */
  updateBooking(id: string, fromStatuses: BookingRow["status"][], patch: Partial<Pick<BookingRow, "status" | "request_message_id" | "reply_text" | "reply_message_id" | "reply_has_link" | "confirmed_at" | "stalled_at" | "cancel_reason" | "human_attested_at">>): Promise<BookingRow | null>;
  /** Mark a handoff's instructions overdue (once; only while it waits for them). */
  markHandoffStalled(id: string, at: string): Promise<PaymentHandoffRow | null>;
  /** Null when the handoff already has a receipt. */
  insertHandoffReceipt(r: Omit<HandoffReceiptRow, "created_at">): Promise<HandoffReceiptRow | null>;
  getHandoffReceipt(handoffId: string): Promise<HandoffReceiptRow | null>;
  // inbound review (migration 112), appended
  /** Append-only; null when the message already has a decision. */
  insertQuarantineResolution(r: Omit<QuarantineResolutionRow, "resolved_at">): Promise<QuarantineResolutionRow | null>;
  listQuarantineResolutions(q: { messageId?: string; jobId?: string; limit?: number }): Promise<QuarantineResolutionRow[]>;
  /** Inbound email held for review, newest first: kind 'quarantine', or a reply stored untrusted. */
  listQuarantinedMessages(q: { jobId?: string; limit?: number }): Promise<MessageRow[]>;
  // inbound reconciler high-water marks (migration 117), appended; optional so a reconciler can run without them
  /** The time up to which the reconciler has seen every item of one channel for one buyer identity (null: never). */
  getReconcileCursor?(scope: string, channel: ReconcileChannel): Promise<string | null>;
  /** Move the mark forward (never back). */
  advanceReconcileCursor?(scope: string, channel: ReconcileChannel, at: string): Promise<void>;
  // operator actions (migration 119), appended; optional so a store without them reads as "none recorded"
  /** Append-only audit row (who, what, why, when). */
  appendOperatorAction?(a: Omit<OperatorActionRow, "at">): Promise<OperatorActionRow>;
  /** Newest first. */
  listOperatorActions?(q: { workspaceId?: string; jobId?: string; actions?: OperatorAction[]; limit?: number }): Promise<OperatorActionRow[]>;
  // per-call AI usage (migration 122), appended; optional so a repository without the table still runs
  /** Append one Claude call's reported usage (never fails the call: callers catch). */
  recordAiUsage?(u: Omit<AiUsageRow, "id" | "at"> & { at?: string }): Promise<void>;
  /** Usage rows, oldest first; only these jobs' when given. */
  listAiUsage?(q: { jobIds?: string[]; since?: string; until?: string }): Promise<AiUsageRow[]>;
  // shared rate limits (migration 124), appended; optional so a repository without them still runs
  // (callers then keep their own per-process count)
  /**
   * Takes one slot of `max` in the fixed `windowS` window (aligned to the epoch: 86400 = the UTC day)
   * for this bucket and key, atomically across every process on the store. A refused take doesn't count.
   * Throws on a bad window (1..86400 s) or max (> 0).
   */
  takeRateSlot?(bucket: string, key: string, windowS: number, max: number): Promise<RateSlot>;
  /** Slots taken in the current window (0 when none). Read-only. */
  rateSlotUsed?(bucket: string, key: string, windowS: number): Promise<number>;
}

/** One take_rate_slot answer: granted or not, the window's count, and the seconds until it ends when refused (0 when granted). */
export interface RateSlot { allowed: boolean; used: number; retryAfterS: number }

/** What take_rate_slot (migration 124) refuses, or null: the same checks for the in-memory store. */
export function rateSlotProblem(bucket: string, key: string, windowS: number, max: number): string | null {
  if (!(bucket.length >= 1 && bucket.length <= 64)) return "rate slot bucket must be 1-64 characters";
  if (!(key.length >= 1 && key.length <= 200)) return "rate slot key must be 1-200 characters";
  if (!(Number.isInteger(windowS) && windowS >= 1 && windowS <= 86_400)) return "rate slot window must be 1-86400 seconds";
  if (!(Number.isInteger(max) && max >= 1 && max <= 2_147_483_647)) return "rate slot max must be a positive integer";
  return null;
}

/** What an operator did, from the scripts (migration 119). */
export type OperatorAction =
  | "workspace_created" | "workspace_suspended" | "workspace_resumed" | "credentials_revoked" | "credentials_rotated"
  | "approver_changed" | "approver_verified" | "approver_unverified" | "cap_changed"
  | "vendor_added" | "vendor_removed" | "suppression_removed"
  | "text_release_requested" | "callback_requested" | "job_held" | "job_resumed" | "job_close_requested"
  | "retry_requested" | "review_resolved";

/** One operator action (migration 119; append-only). */
export interface OperatorActionRow {
  id: string;
  workspace_id: string | null;
  job_id: string | null;
  action: OperatorAction;
  operator: string;
  reason: string;
  detail: Record<string, unknown>;
  at: string;
}

/** One Claude call's usage as the API reported it (migration 122). Missing counts are 0, never guessed. */
export interface AiUsageRow {
  id: number;
  job_id: string | null;
  workspace_id: string | null;
  purpose: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  at: string;
}

/** An operator's decision on a quarantined inbound message (migration 112; append-only, one per message). */
export interface QuarantineResolutionRow {
  id: string;
  message_id: string;
  job_id: string | null;
  business_id: string | null;
  decision: "released" | "rejected";
  original_reason: string;
  original_trust_reason: string | null;
  resolved_by: string;
  /** How it was independently verified (release) or why it was rejected. */
  verification: string;
  released_trust_reason: "operator_verified" | null;
  resolved_at: string;
}

/** The reconciler's sources, each with its own high-water mark (migration 117). */
export type ReconcileChannel = "email" | "email_status" | "text" | "call";
