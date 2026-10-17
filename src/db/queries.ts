// Typed query helpers over the Section 6 tables. Every function here does one
// database round trip (or a small retry loop) and throws DbError on failure.
import { db, must, DbError, UNIQUE_VIOLATION } from "./client.js";
import type { QuoteRecord } from "../parser/quoteSchema.js";
import type { ApprovalCandidate, VendorCandidate } from "../channels/matching.js";
import type { JobStatus } from "../jobs/stateMachine.js";

// ---------- Row types ----------

export interface EventDetails {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  headcount: number;
  location: string;
  dietary: { need: string; count: number }[];
  cuisine?: string;
  notes?: string;
}

export interface JobRow {
  id: string;
  short_code: string;
  status: JobStatus;
  version: number;
  event: EventDetails;
  budget_per_head_cents: number | null;
  max_rounds: number;
  round: number;
  collect_until: string | null;
  client_request_id: string | null;
  owner_id: string | null; // Supabase user id (oauth mode); null in token mode
  created_at: string;
  updated_at: string;
}

export interface VendorRow {
  id: string;
  job_id: string;
  name: string;
  email: string | null;
  channel: "email" | "phone";
  status: string; // pending, contacted, replied, declined, no_reply, bounced, send_failed
  outbound_email_id: string | null;
  outbound_message_id: string | null;
  thread_id: string | null;
  last_message_at: string | null;
}

export type MessageKind =
  | "outreach"
  | "counter"
  | "approval_request"
  | "receipt"
  | "cancel_note"
  | "reply"
  | "approval_reply";

export interface MessageRow {
  id: string;
  job_id: string | null;
  vendor_id: string | null;
  approval_id: string | null;
  direction: "in" | "out";
  kind: MessageKind;
  round: number | null; // negotiation round, for counteroffers
  provider_email_id: string | null;
  rfc_message_id: string | null;
  thread_id: string | null;
  from_address: string | null;
  subject: string | null;
  body_text: string | null;
  attachments: { filename: string | null; content_type: string; size_bytes: number; tar_path?: string }[];
  attachments_download_url: string | null;
  sender_authenticated: boolean | null;
  parse_status: "none" | "pending" | "done" | "failed";
  created_at: string;
}

export type NewMessage = Omit<
  MessageRow,
  "id" | "created_at" | "approval_id" | "rfc_message_id" | "attachments_download_url" | "round"
> &
  Partial<Pick<MessageRow, "approval_id" | "rfc_message_id" | "attachments_download_url" | "round">>;

export interface QuoteRow extends QuoteRecord {
  id: string;
  job_id: string;
  vendor_id: string;
  source_message_id: string;
  round: number;
  is_current: boolean;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  job_id: string;
  quote_id: string;
  vendor_id: string;
  amount_cents: number;
  code: string;
  status: "pending" | "approved" | "declined" | "expired" | "used";
  approver_email: string;
  outbound_email_id: string | null;
  outbound_message_id: string | null;
  thread_id: string | null;
  decision_message_id: string | null;
  requested_at: string;
  decided_at: string | null;
  expires_at: string;
}

export interface PaymentRow {
  id: string;
  job_id: string;
  approval_id: string;
  amount_cents: number;
  stripe_payment_intent_id: string | null;
  status: "succeeded" | "failed";
  idempotency_key: string;
  created_at: string;
}

export interface JobEventRow {
  id: number;
  job_id: string;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
}

// ---------- Jobs ----------

export async function getJob(jobId: string): Promise<JobRow | null> {
  return must(await db().from("jobs").select("*").eq("id", jobId).maybeSingle(), "getJob") as JobRow | null;
}

export async function findJobByClientRequestId(id: string): Promise<JobRow | null> {
  return must(
    await db().from("jobs").select("*").eq("client_request_id", id).maybeSingle(),
    "findJobByClientRequestId",
  ) as JobRow | null;
}

export async function insertJob(row: {
  short_code: string;
  status: JobStatus;
  event: EventDetails;
  budget_per_head_cents: number | null;
  max_rounds: number;
  collect_until: string;
  client_request_id: string | null;
  owner_id?: string; // public mode only
}): Promise<JobRow> {
  return must(await db().from("jobs").insert(row).select("*").single(), "insertJob") as JobRow;
}

/** How many jobs this user created since `sinceIso` (per-user daily limit). */
export async function countJobsByOwnerSince(ownerId: string, sinceIso: string): Promise<number> {
  const res = await db().from("jobs").select("id", { count: "exact", head: true }).eq("owner_id", ownerId).gte("created_at", sinceIso);
  if (res.error) throw new DbError(`countJobsByOwnerSince: ${res.error.message}`, res.error.code);
  return res.count ?? 0;
}

/**
 * Compare-and-swap (DESIGN.md §6): apply `patch` and bump the version only if
 * the job is still at `expectedVersion`. Returns the new row, or null if
 * someone else changed the job first (the caller reloads and decides again).
 */
export async function casJob(jobId: string, expectedVersion: number, patch: Partial<JobRow>): Promise<JobRow | null> {
  const rows = must(
    await db()
      .from("jobs")
      .update({ ...patch, version: expectedVersion + 1, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("version", expectedVersion)
      .select("*"),
    "casJob",
  ) as JobRow[];
  return rows[0] ?? null;
}

/** Bump the version (with an optional patch), retrying on conflict. */
export async function updateJobVersioned(jobId: string, patch: Partial<JobRow> = {}): Promise<JobRow> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const job = await getJob(jobId);
    if (!job) throw new DbError(`job ${jobId} not found`);
    const updated = await casJob(jobId, job.version, patch);
    if (updated) return updated;
  }
  throw new DbError(`job ${jobId}: version conflict after 3 attempts`);
}

/** Most recent jobs first (live page index). */
export async function listRecentJobs(limit: number): Promise<JobRow[]> {
  return must(
    await db().from("jobs").select("*").order("created_at", { ascending: false }).limit(limit),
    "listRecentJobs",
  ) as JobRow[];
}

export async function listOpenJobIds(): Promise<string[]> {
  const rows = must(
    await db().from("jobs").select("id").not("status", "in", "(paid,expired,cancelled)"),
    "listOpenJobIds",
  ) as { id: string }[];
  return rows.map((r) => r.id);
}

export async function insertJobEvent(jobId: string, type: string, data: Record<string, unknown> = {}) {
  must(await db().from("job_events").insert({ job_id: jobId, type, data }), "insertJobEvent");
}

/** Has an event of this type been recorded for the given round? */
export async function hasRoundEvent(jobId: string, type: string, round: number): Promise<boolean> {
  const rows = must(
    await db().from("job_events").select("id").eq("job_id", jobId).eq("type", type).eq("data->>round", String(round)).limit(1),
    "hasRoundEvent",
  ) as { id: number }[];
  return rows.length > 0;
}

export async function getJobEvents(jobId: string, limit: number): Promise<JobEventRow[]> {
  return must(
    await db().from("job_events").select("*").eq("job_id", jobId).order("id", { ascending: false }).limit(limit),
    "getJobEvents",
  ) as JobEventRow[];
}

// ---------- Vendors ----------

export async function insertVendors(
  jobId: string,
  vendors: { name: string; email: string }[],
): Promise<VendorRow[]> {
  const rows = vendors.map((v) => ({ job_id: jobId, name: v.name, email: v.email.toLowerCase() }));
  return must(await db().from("vendors").insert(rows).select("*"), "insertVendors") as VendorRow[];
}

export async function getVendors(jobId: string): Promise<VendorRow[]> {
  return must(
    await db().from("vendors").select("*").eq("job_id", jobId).order("name"),
    "getVendors",
  ) as VendorRow[];
}

export async function updateVendor(vendorId: string, patch: Partial<VendorRow>) {
  must(await db().from("vendors").update(patch).eq("id", vendorId), "updateVendor");
}

/** Mark every still-waiting vendor on a job as no_reply (collection closed). */
export async function markSilentVendors(jobId: string) {
  must(
    await db().from("vendors").update({ status: "no_reply" }).eq("job_id", jobId).eq("status", "contacted"),
    "markSilentVendors",
  );
}

export async function findVendorByOutboundEmailId(sentEmailId: string): Promise<VendorRow | null> {
  return must(
    await db().from("vendors").select("*").eq("outbound_email_id", sentEmailId).maybeSingle(),
    "findVendorByOutboundEmailId",
  ) as VendorRow | null;
}

/** Stored ids may or may not carry angle brackets; query both spellings. */
function messageIdVariants(ids: string[]): string[] {
  return ids.flatMap((id) => {
    const bare = id.trim().replace(/^<|>$/g, "");
    return [bare, `<${bare}>`];
  });
}

/**
 * Load every vendor that could match an inbound email: by thread id, by any
 * referenced Message-ID, or by the job short code in the subject.
 */
export async function findVendorCandidates(opts: {
  threadId: string | null;
  messageIds: string[];
  shortCode: string | null;
}): Promise<VendorCandidate[]> {
  const select = "id, job_id, email, thread_id, outbound_message_id, jobs!inner(short_code)";
  const found: Record<string, unknown>[] = [];
  const q = () => db().from("vendors").select(select);

  if (opts.threadId) found.push(...(must(await q().eq("thread_id", opts.threadId), "byThread") as Record<string, unknown>[]));
  if (opts.messageIds.length > 0) {
    found.push(...(must(await q().in("outbound_message_id", messageIdVariants(opts.messageIds)), "byMessageId") as Record<string, unknown>[]));
  }
  if (opts.shortCode) found.push(...(must(await q().eq("jobs.short_code", opts.shortCode), "byShortCode") as Record<string, unknown>[]));

  const byId = new Map<string, VendorCandidate>();
  for (const r of found) {
    byId.set(r.id as string, {
      vendorId: r.id as string,
      jobId: r.job_id as string,
      shortCode: shortCodeOf(r),
      email: (r.email as string | null) ?? null,
      threadId: (r.thread_id as string | null) ?? null,
      outboundMessageId: (r.outbound_message_id as string | null) ?? null,
    });
  }
  return [...byId.values()];
}

function shortCodeOf(row: Record<string, unknown>): string {
  const job = row.jobs as { short_code: string } | { short_code: string }[];
  return Array.isArray(job) ? job[0]!.short_code : job.short_code;
}

// ---------- Messages ----------

/** Insert a message; returns null if this provider email id was already stored. */
export async function insertMessage(row: NewMessage): Promise<MessageRow | null> {
  const res = await db().from("messages").insert(row).select("*").single();
  if (res.error?.code === UNIQUE_VIOLATION) return null;
  return must(res, "insertMessage") as MessageRow;
}

export async function getPendingMessages(jobId: string): Promise<MessageRow[]> {
  return must(
    await db().from("messages").select("*").eq("job_id", jobId).eq("parse_status", "pending").order("created_at"),
    "getPendingMessages",
  ) as MessageRow[];
}

export async function setParseStatus(messageId: string, status: MessageRow["parse_status"]) {
  must(await db().from("messages").update({ parse_status: status }).eq("id", messageId), "setParseStatus");
}

/** The vendor's most recent inbound email: the one we reply to, to stay in their thread. */
export async function getLatestInboundFromVendor(vendorId: string): Promise<MessageRow | null> {
  return must(
    await db()
      .from("messages")
      .select("*")
      .eq("vendor_id", vendorId)
      .eq("direction", "in")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "getLatestInboundFromVendor",
  ) as MessageRow | null;
}

/** Every message on a job, oldest first (live page timeline). */
export async function getMessagesForJob(jobId: string): Promise<MessageRow[]> {
  return must(
    await db().from("messages").select("*").eq("job_id", jobId).order("created_at"),
    "getMessagesForJob",
  ) as MessageRow[];
}

/** Vendors that were sent a counteroffer in this round. */
export async function getCounteredVendorIds(jobId: string, round: number): Promise<string[]> {
  const rows = must(
    await db()
      .from("messages")
      .select("vendor_id")
      .eq("job_id", jobId)
      .eq("kind", "counter")
      .eq("direction", "out")
      .eq("round", round),
    "getCounteredVendorIds",
  ) as { vendor_id: string }[];
  return rows.map((r) => r.vendor_id);
}

// ---------- Webhook dedupe ----------

export async function webhookEventSeen(eventId: string): Promise<boolean> {
  const res = must(await db().from("webhook_events").select("id").eq("id", eventId).maybeSingle(), "webhookEventSeen");
  return res !== null;
}

/** Returns true the first time an event id is recorded, false on a replay. */
export async function recordWebhookEvent(eventId: string): Promise<boolean> {
  const res = await db().from("webhook_events").insert({ id: eventId });
  if (res.error?.code === UNIQUE_VIOLATION) return false;
  must(res, "recordWebhookEvent");
  return true;
}

// ---------- Quotes ----------

/**
 * Save a parsed quote as the vendor's current one. Returns null if a quote for
 * this source message already exists (a concurrent parse got there first).
 */
export async function insertCurrentQuote(row: QuoteRecord & {
  job_id: string;
  vendor_id: string;
  source_message_id: string;
  round: number;
}): Promise<QuoteRow | null> {
  const res = await db().from("quotes").insert({ ...row, is_current: true }).select("*").single();
  if (res.error?.code === UNIQUE_VIOLATION) return null;
  const quote = must(res, "insertQuote") as QuoteRow;
  // Older quotes from this vendor stop being current.
  must(
    await db().from("quotes").update({ is_current: false }).eq("vendor_id", row.vendor_id).neq("id", quote.id),
    "retireOlderQuotes",
  );
  return quote;
}

export async function getCurrentQuotes(jobId: string): Promise<QuoteRow[]> {
  return must(
    await db().from("quotes").select("*").eq("job_id", jobId).eq("is_current", true),
    "getCurrentQuotes",
  ) as QuoteRow[];
}

export async function getQuote(quoteId: string): Promise<QuoteRow | null> {
  return must(await db().from("quotes").select("*").eq("id", quoteId).maybeSingle(), "getQuote") as QuoteRow | null;
}

// ---------- Approvals ----------

export async function insertApproval(row: {
  job_id: string;
  quote_id: string;
  vendor_id: string;
  amount_cents: number;
  code: string;
  approver_email: string;
  expires_at: string;
}): Promise<ApprovalRow | null> {
  const res = await db().from("approvals").insert(row).select("*").single();
  // The partial unique index allows one pending approval per job.
  if (res.error?.code === UNIQUE_VIOLATION) return null;
  return must(res, "insertApproval") as ApprovalRow;
}

export async function getApproval(approvalId: string): Promise<ApprovalRow | null> {
  return must(await db().from("approvals").select("*").eq("id", approvalId).maybeSingle(), "getApproval") as ApprovalRow | null;
}

export async function getLatestApproval(jobId: string): Promise<ApprovalRow | null> {
  return must(
    await db().from("approvals").select("*").eq("job_id", jobId).order("requested_at", { ascending: false }).limit(1).maybeSingle(),
    "getLatestApproval",
  ) as ApprovalRow | null;
}

/** Every approval on a job, newest first (live page). */
export async function getApprovalsForJob(jobId: string): Promise<ApprovalRow[]> {
  return must(
    await db().from("approvals").select("*").eq("job_id", jobId).order("requested_at", { ascending: false }),
    "getApprovalsForJob",
  ) as ApprovalRow[];
}

export async function getPendingApproval(jobId: string): Promise<ApprovalRow | null> {
  return must(
    await db().from("approvals").select("*").eq("job_id", jobId).eq("status", "pending").maybeSingle(),
    "getPendingApproval",
  ) as ApprovalRow | null;
}

export async function updateApproval(approvalId: string, patch: Partial<ApprovalRow>) {
  must(await db().from("approvals").update(patch).eq("id", approvalId), "updateApproval");
}

/** Conditional update: only if the approval is still in `fromStatus`. Returns true if it changed. */
export async function transitionApproval(
  approvalId: string,
  fromStatus: ApprovalRow["status"],
  patch: Partial<ApprovalRow>,
): Promise<boolean> {
  const rows = must(
    await db().from("approvals").update(patch).eq("id", approvalId).eq("status", fromStatus).select("id"),
    "transitionApproval",
  ) as { id: string }[];
  return rows.length === 1;
}

export async function findApprovalCandidates(opts: {
  threadId: string | null;
  messageIds: string[];
  shortCode: string | null;
}): Promise<ApprovalCandidate[]> {
  const select = "id, job_id, approver_email, thread_id, outbound_message_id, jobs!inner(short_code)";
  const q = () => db().from("approvals").select(select).eq("status", "pending");
  const found: Record<string, unknown>[] = [];

  if (opts.threadId) found.push(...(must(await q().eq("thread_id", opts.threadId), "apByThread") as Record<string, unknown>[]));
  if (opts.messageIds.length > 0) {
    found.push(...(must(await q().in("outbound_message_id", messageIdVariants(opts.messageIds)), "apByMessageId") as Record<string, unknown>[]));
  }
  if (opts.shortCode) found.push(...(must(await q().eq("jobs.short_code", opts.shortCode), "apByShortCode") as Record<string, unknown>[]));

  const byId = new Map<string, ApprovalCandidate>();
  for (const r of found) {
    byId.set(r.id as string, {
      approvalId: r.id as string,
      jobId: r.job_id as string,
      shortCode: shortCodeOf(r),
      approverEmail: r.approver_email as string,
      threadId: (r.thread_id as string | null) ?? null,
      outboundMessageId: (r.outbound_message_id as string | null) ?? null,
    });
  }
  return [...byId.values()];
}

// ---------- Payments ----------

export async function getPaymentByApproval(approvalId: string): Promise<PaymentRow | null> {
  return must(
    await db().from("payments").select("*").eq("approval_id", approvalId).maybeSingle(),
    "getPaymentByApproval",
  ) as PaymentRow | null;
}

export async function getPaymentsForJob(jobId: string): Promise<PaymentRow[]> {
  return must(
    await db().from("payments").select("*").eq("job_id", jobId).order("created_at"),
    "getPaymentsForJob",
  ) as PaymentRow[];
}

// ---------- Users (oauth mode) ----------

export interface AppUserRow {
  id: string;
  email: string;
  stripe_customer_id: string | null;
  stripe_payment_method_id: string | null;
  created_at: string;
}

/** Get the user's row, creating it on first use. */
export async function ensureAppUser(id: string, email: string): Promise<AppUserRow> {
  must(await db().from("app_users").upsert({ id, email }, { onConflict: "id", ignoreDuplicates: true }), "ensureAppUser");
  return must(await db().from("app_users").select("*").eq("id", id).single(), "getAppUser") as AppUserRow;
}

export async function updateAppUser(id: string, patch: Partial<AppUserRow>) {
  must(await db().from("app_users").update(patch).eq("id", id), "updateAppUser");
}

// ---------- Simulator state (SIM_ON_SERVER) ----------

export interface SimStateRow {
  persona_id: string;
  cursor: string | null;
  last_price: Record<string, number>;
}

export async function getSimStates(): Promise<SimStateRow[]> {
  return must(await db().from("sim_state").select("persona_id, cursor, last_price"), "getSimStates") as SimStateRow[];
}

export async function saveSimState(row: SimStateRow) {
  must(await db().from("sim_state").upsert({ ...row, updated_at: new Date().toISOString() }), "saveSimState");
}

/** Returns null if a payment for this approval already exists (unique approval_id). */
export async function insertPayment(row: Omit<PaymentRow, "id" | "created_at">): Promise<PaymentRow | null> {
  const res = await db().from("payments").insert(row).select("*").single();
  if (res.error?.code === UNIQUE_VIOLATION) return null;
  return must(res, "insertPayment") as PaymentRow;
}
