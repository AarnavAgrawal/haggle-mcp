// In-memory Repository for tests and mock mode. Enforces the same uniqueness rules as
// supabase/migrations/100_engine_core.sql so tests exercise real invariants. Single-process only.
import { newId } from "../ids.ts";
import { approvalUpdateViolation } from "../payments/guard.ts";
import {
  DEFAULT_WORKSPACE_ID,
  type ApprovalRow,
  type ReconcileChannel,
  type JobBusinessRow,
  type JobEventRow,
  type JobRow,
  type MessageRow,
  type NewMessage,
  type PaymentRow,
  type QuestionRow,
  type QuoteRow,
  type Repository,
  type SettingsRow,
  type WorkspaceRow,
  type OutboxRow,
  type SuppressionRow,
  type WorkspaceVendorRow,
  type PaymentHandoffRow,
  type TextRouteRow,
  type HeldTextRow,
  type SuppressionRemovalRow,
  type OperatorReviewRow,
  type BookingRow,
  type HandoffReceiptRow,
  type QuarantineResolutionRow,
  type OperatorActionRow,
  type OperatorAction,
  type AiUsageRow,
} from "./types.ts";

const now = () => new Date().toISOString();
const clone = <T>(v: T): T => structuredClone(v);
const norm = (id: string) => id.trim().replace(/^<|>$/g, "").toLowerCase();

export class InMemoryRepository implements Repository {
  private jobs = new Map<string, JobRow>();
  private businesses: JobBusinessRow[] = [];
  private messages: MessageRow[] = [];
  private quotes: QuoteRow[] = [];
  private questions: QuestionRow[] = [];
  private approvals: ApprovalRow[] = [];
  private payments: PaymentRow[] = [];
  private events: JobEventRow[] = [];
  private inboundEvents = new Set<string>();
  private settings = new Map<string, SettingsRow>();
  private workspaces = new Map<string, WorkspaceRow>([[DEFAULT_WORKSPACE_ID, { id: DEFAULT_WORKSPACE_ID, name: "Default workspace", token_hash: null, connector_secret_hash: null, timezone: "America/Los_Angeles", created_at: now() }]]);

  async insertWorkspace(w: Omit<WorkspaceRow, "created_at">) {
    if (this.workspaces.has(w.id)) throw new Error("duplicate workspace id");
    const all = [...this.workspaces.values()];
    if (w.token_hash && all.some((x) => x.token_hash === w.token_hash)) throw new Error("duplicate token_hash");
    if (w.connector_secret_hash && all.some((x) => x.connector_secret_hash === w.connector_secret_hash)) throw new Error("duplicate connector_secret_hash");
    const row = { ...clone(w), created_at: now() };
    this.workspaces.set(w.id, row);
    return clone(row);
  }
  async getWorkspace(id: string) {
    const w = this.workspaces.get(id);
    return w ? clone(w) : null;
  }
  async findWorkspaceByTokenHash(hash: string) {
    const w = [...this.workspaces.values()].find((x) => x.token_hash !== null && x.token_hash === hash && !x.revoked_at);
    return w ? clone(w) : null;
  }
  async findWorkspaceBySecretHash(hash: string) {
    const w = [...this.workspaces.values()].find((x) => x.connector_secret_hash !== null && x.connector_secret_hash === hash && !x.revoked_at);
    return w ? clone(w) : null;
  }  private leases = new Map<string, { owner: string; expires: number }>();
  private outbox = new Map<string, OutboxRow>();
  private suppressions = new Map<string, SuppressionRow>();
  private vendors: WorkspaceVendorRow[] = [];
  private handoffs: PaymentHandoffRow[] = [];

  async acquireJobLease(jobId: string, owner: string, now: string, ttlMs: number) {
    const cur = this.leases.get(jobId);
    const t = Date.parse(now);
    if (cur && cur.owner !== owner && cur.expires > t) return false;
    this.leases.set(jobId, { owner, expires: t + ttlMs });
    return true;
  }
  async releaseJobLease(jobId: string, owner: string) {
    if (this.leases.get(jobId)?.owner === owner) this.leases.delete(jobId);
  }
  async claimOutbox(o: { key: string; job_id: string | null; kind: OutboxRow["kind"] }, now: string) {
    const cur = this.outbox.get(o.key);
    if (cur) return { fresh: false, row: clone(cur) };
    const row: OutboxRow = { ...o, status: "pending", provider_ref: null, attempts: 1, created_at: now, updated_at: now };
    this.outbox.set(o.key, row);
    return { fresh: true, row: clone(row) };
  }
  async reclaimOutbox(key: string, fromStatuses: OutboxRow["status"][], now: string) {
    const cur = this.outbox.get(key);
    if (!cur || !fromStatuses.includes(cur.status)) return null;
    // The database refuses re-attempting a call that may have gone out (106 haggle_outbox_transition).
    if (cur.kind === "call" && cur.status !== "not_sent") return null;
    // 109 haggle_outbox_reliability / 106 attempts check.
    if (cur.status !== "pending" && this.openReviewFor("outbox", key)) throw new Error(`outbox action ${key} is under operator review`);
    if (cur.attempts + 1 > 20) throw new Error("outbox attempts check violated");
    const next = { ...cur, status: "pending" as const, attempts: cur.attempts + 1, updated_at: now };
    this.outbox.set(key, next);
    return clone(next);
  }
  async finishOutbox(key: string, status: Exclude<OutboxRow["status"], "pending">, providerRef: string | null, now: string) {
    const cur = this.outbox.get(key);
    if (!cur || cur.status === "sent") return;
    if (cur.kind === "call" && cur.status === "unknown" && status === "not_sent") throw new Error("a call whose outcome is unknown is never marked not sent");
    this.outbox.set(key, { ...cur, status, provider_ref: providerRef ?? cur.provider_ref, updated_at: now });
  }
  async getOutbox(key: string) {
    const r = this.outbox.get(key);
    return r ? clone(r) : null;
  }
  async addSuppression(s: Omit<SuppressionRow, "created_at">) {
    if (!this.suppressions.has(s.contact)) this.suppressions.set(s.contact, { ...s, created_at: now() });
  }
  async findSuppressions(contacts: string[]) {
    return contacts.map((c) => this.suppressions.get(c.toLowerCase())).filter((x): x is SuppressionRow => !!x).map(clone);
  }
  async addWorkspaceVendor(v: Omit<WorkspaceVendorRow, "created_at">) {
    if (!this.workspaces.has(v.workspace_id)) throw new Error("unknown workspace_id");
    this.vendors = this.vendors.filter((x) => !(x.workspace_id === v.workspace_id && x.contact === v.contact));
    const row = { ...v, created_at: now() };
    this.vendors.push(row);
    return clone(row);
  }
  async removeWorkspaceVendor(workspaceId: string, contact: string) {
    const before = this.vendors.length;
    this.vendors = this.vendors.filter((x) => !(x.workspace_id === workspaceId && x.contact === contact));
    return this.vendors.length < before;
  }
  async listWorkspaceVendors(workspaceId: string) {
    return this.vendors.filter((x) => x.workspace_id === workspaceId).map(clone);
  }
  async insertHandoff(h: Omit<PaymentHandoffRow, "created_at" | "updated_at">) {
    if (this.handoffs.some((x) => x.approval_id === h.approval_id)) return null;
    const a = this.approvals.find((x) => x.id === h.approval_id);
    if (!a || a.job_id !== h.job_id || a.business_id !== h.business_id || a.payment_cents !== h.amount_cents || a.action === "confirm" || !["approved", "used"].includes(a.status)) throw new Error("handoff must match a human-approved paying approval");
    // 110: a handoff starts only after the booking is confirmed (or confirmed by the human directly).
    // 118: a booking Haggle can't confirm in writing counts only once the human accepted it (BOOKED <code>).
    if (!this.bookings.some((x) => x.approval_id === h.approval_id && (x.status === "confirmed" || (x.status === "not_in_writing" && !!x.human_attested_at)))) throw new Error("a payment handoff starts only after the booking is confirmed");
    const row = { stalled_at: null, ...h, created_at: now(), updated_at: now() };
    this.handoffs.push(row);
    return clone(row);
  }
  async getHandoffByApproval(approvalId: string) {
    const h = this.handoffs.find((x) => x.approval_id === approvalId);
    return h ? clone(h) : null;
  }
  async updateHandoff(id: string, fromStatuses: PaymentHandoffRow["status"][], patch: Partial<Pick<PaymentHandoffRow, "status" | "instructions_text" | "instructions_message_id" | "confirmed_by" | "confirmed_at">>) {
    const i = this.handoffs.findIndex((x) => x.id === id);
    if (i < 0 || !fromStatuses.includes(this.handoffs[i]!.status) || ["human_confirmed", "cancelled"].includes(this.handoffs[i]!.status)) return null;
    this.handoffs[i] = { ...this.handoffs[i]!, ...patch, updated_at: now() };
    return clone(this.handoffs[i]!);
  }
  async setWorkspaceCredentials(id: string, c: { token_hash?: string | null; connector_secret_hash?: string | null; revoked: boolean }) {
    const w = this.workspaces.get(id);
    if (!w) return null;
    const next = { ...w, ...(c.token_hash !== undefined ? { token_hash: c.token_hash } : {}), ...(c.connector_secret_hash !== undefined ? { connector_secret_hash: c.connector_secret_hash } : {}), revoked_at: c.revoked ? now() : null };
    this.workspaces.set(id, next);
    return clone(next);
  }


  async insertJob(job: JobRow) {
    if (this.jobs.has(job.id)) throw new Error("duplicate job id");
    if (!this.workspaces.has(job.workspace_id)) throw new Error("unknown workspace_id");
    if (job.client_request_id && [...this.jobs.values()].some((j) => j.workspace_id === job.workspace_id && j.client_request_id === job.client_request_id)) throw new Error("duplicate client_request_id");
    if ([...this.jobs.values()].some((j) => j.short_code === job.short_code)) throw new Error("duplicate short_code");
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? clone(j) : null;
  }
  async findJobByClientRequestId(id: string, workspaceId = DEFAULT_WORKSPACE_ID) {
    const j = [...this.jobs.values()].find((x) => x.workspace_id === workspaceId && x.client_request_id === id);
    return j ? clone(j) : null;
  }
  async findJobByShortCode(code: string) {
    const j = [...this.jobs.values()].find((x) => x.short_code === code.toUpperCase());
    return j ? clone(j) : null;
  }
  async casJob(id: string, expectedVersion: number, patch: Partial<JobRow>) {
    const j = this.jobs.get(id);
    if (!j || j.version !== expectedVersion) return null;
    Object.assign(j, patch, { version: j.version + 1, updated_at: now() });
    return clone(j);
  }
  async touchJob(id: string, patch: Partial<JobRow> = {}) {
    const j = this.jobs.get(id);
    if (!j) return null;
    Object.assign(j, patch, { version: j.version + 1, updated_at: now() });
    return clone(j);
  }
  async listOpenJobs() {
    return [...this.jobs.values()].filter((j) => !["paid", "confirmed", "cancelled", "failed"].includes(j.state)).map(clone);
  }

  async insertBusinesses(rows: JobBusinessRow[]) {
    for (const r of rows) {
      if (this.businesses.some((b) => b.job_id === r.job_id && (b.business_id === r.business_id || (r.email !== null && b.email === r.email)))) throw new Error("duplicate business on job");
    }
    this.businesses.push(...rows.map(clone));
  }
  async getBusinesses(jobId: string) {
    return this.businesses.filter((b) => b.job_id === jobId).map(clone);
  }
  async updateBusiness(jobId: string, businessId: string, patch: Partial<JobBusinessRow>, opts: { ifStatus?: JobBusinessRow["status"][] } = {}) {
    const b = this.businesses.find((x) => x.job_id === jobId && x.business_id === businessId);
    if (!b) return;
    if (opts.ifStatus && !opts.ifStatus.includes(b.status)) return;
    // Snapshots are immutable (DB trigger in the migration).
    const { business_id: _a, name: _b, email: _c, job_id: _d, phone: _e, ...rest } = patch;
    Object.assign(b, rest);
  }
  async findBusinessCandidates(q: { shortCodes: string[]; threadId: string | null; messageIds: string[] }) {
    const ids = new Set(q.messageIds.map(norm));
    const codes = new Set(q.shortCodes.map((c) => c.toUpperCase()));
    return this.businesses
      .map((b) => ({ ...clone(b), short_code: this.jobs.get(b.job_id)?.short_code ?? "" }))
      .filter((b) => codes.has(b.short_code) || (q.threadId !== null && b.thread_id === q.threadId) || (b.rfq_message_id !== null && ids.has(norm(b.rfq_message_id))) || this.messages.some((m) => m.direction === "out" && m.business_id === b.business_id && m.job_id === b.job_id && m.rfc_message_id !== null && ids.has(norm(m.rfc_message_id))));
  }

  /** Strictly increasing message times (like Postgres's microseconds), so "after" never ties. */
  private lastMessageMs = 0;
  async insertMessage(m: NewMessage) {
    if (m.provider_email_id && this.messages.some((x) => x.provider_email_id === m.provider_email_id)) return null;
    if (m.idempotency_key && this.messages.some((x) => x.idempotency_key === m.idempotency_key)) return null;
    this.lastMessageMs = Math.max(Date.now(), this.lastMessageMs + 1);
    const row: MessageRow = { ...clone(m), channel: m.channel ?? "email", id: newId("msg"), created_at: new Date(this.lastMessageMs).toISOString() };
    this.messages.push(row);
    return clone(row);
  }
  async findMessageByIdempotencyKey(key: string) {
    const m = this.messages.find((x) => x.idempotency_key === key);
    return m ? clone(m) : null;
  }
  async findMessageByProviderId(providerId: string) {
    const m = this.messages.find((x) => x.provider_email_id === providerId);
    return m ? clone(m) : null;
  }
  async getMessage(id: string) {
    const m = this.messages.find((x) => x.id === id);
    return m ? clone(m) : null;
  }
  async updateMessage(id: string, patch: Partial<MessageRow>) {
    const m = this.messages.find((x) => x.id === id);
    if (!m) return;
    // Migration 112's trigger: an untrusted inbound message is trusted only through a recorded release.
    const next = { ...m, ...patch };
    if (m.direction === "in" && m.sender_trusted !== true && next.sender_trusted === true) {
      const r = this.resolutions.find((x) => x.message_id === id && x.decision === "released");
      if (next.trust_reason !== "operator_verified" || !r || r.job_id !== next.job_id || r.business_id !== next.business_id || (m.quarantine_reason !== null && next.quarantine_reason !== m.quarantine_reason)) throw new Error("releasing a quarantined message needs a recorded operator release for it");
    }
    if (m.kind === "quarantine" && next.kind !== "quarantine" && (next.kind !== "reply" || next.sender_trusted !== true)) throw new Error("a quarantined message can only be released as a trusted reply");
    if (patch.delivery_status && (m.direction !== "out" || m.channel !== "email" || !next.delivery_status_at)) throw new Error("delivery status is for outbound email only");
    Object.assign(m, patch);
  }
  async listMessages(jobId: string) {
    return this.messages.filter((m) => m.job_id === jobId).map(clone);
  }
  async listJobBusinessesByContact(c: { email?: string | null; phone?: string | null }) {
    return this.businesses.filter((b) => (!!c.email && b.email === c.email) || (!!c.phone && b.phone === c.phone)).map(clone);
  }
  async listMessagesForBusiness(businessId: string) {
    return this.messages.filter((m) => m.business_id === businessId).map(clone);
  }
  async getPendingMessages(jobId: string) {
    return this.messages.filter((m) => m.job_id === jobId && m.parse_status === "pending").map(clone);
  }
  async findOutboundByRfcIds(ids: string[]) {
    const set = new Set(ids.map(norm));
    return this.messages.filter((m) => m.direction === "out" && m.rfc_message_id && set.has(norm(m.rfc_message_id))).map(clone);
  }
  async listPhoneMessages(number: string, sinceIso: string) {
    return this.messages
      .filter((m) => m.channel === "phone" && m.created_at >= sinceIso && (m.direction === "out" ? m.to_address === number : m.from_address === number))
      .map(clone);
  }

  async insertCurrentQuote(q: Omit<QuoteRow, "id" | "created_at" | "status">) {
    if (this.quotes.some((x) => x.message_id === q.message_id)) return null;
    for (const x of this.quotes) if (x.job_id === q.job_id && x.business_id === q.business_id && x.status === "current") x.status = "superseded";
    const row: QuoteRow = { ...clone(q), id: newId("q"), status: "current", created_at: now() };
    this.quotes.push(row);
    return clone(row);
  }
  async getQuote(id: string) {
    const q = this.quotes.find((x) => x.id === id);
    return q ? clone(q) : null;
  }
  async listQuotes(jobId: string) {
    return this.quotes.filter((q) => q.job_id === jobId).map(clone);
  }
  async listQuotesForBusiness(businessId: string) {
    return this.quotes.filter((q) => q.business_id === businessId).map(clone);
  }

  async insertQuestion(q: Omit<QuestionRow, "id" | "created_at" | "status" | "answer" | "answered_at">) {
    const row: QuestionRow = { ...clone(q), id: newId("qn"), status: "pending", answer: null, answered_at: null, created_at: now() };
    this.questions.push(row);
    return clone(row);
  }
  async getQuestion(id: string) {
    const q = this.questions.find((x) => x.id === id);
    return q ? clone(q) : null;
  }
  async listQuestions(jobId: string) {
    return this.questions.filter((q) => q.job_id === jobId).map(clone);
  }
  async answerQuestion(id: string, answer: string) {
    const q = this.questions.find((x) => x.id === id);
    if (!q || q.status !== "pending") return false;
    Object.assign(q, { status: "answered", answer, answered_at: now() });
    return true;
  }

  async insertApproval(a: Omit<ApprovalRow, "created_at">) {
    // Parity with Postgres (105 approvals_match_quote): the approval names its own job's quote, business and total.
    const q = this.quotes.find((x) => x.id === a.quote_id);
    if (!q || q.job_id !== a.job_id || q.business_id !== a.business_id || q.total_cents !== a.quote_total_cents) throw new Error("approval must name its own job's quote, business and total");
    if (this.approvals.some((x) => x.job_id === a.job_id && x.status === "pending")) return null;
    const row: ApprovalRow = { ...clone(a), created_at: now() };
    this.approvals.push(row);
    return clone(row);
  }
  async getApproval(id: string) {
    const a = this.approvals.find((x) => x.id === id);
    return a ? clone(a) : null;
  }
  async getLatestApproval(jobId: string) {
    const list = this.approvals.filter((a) => a.job_id === jobId);
    return list.length ? clone(list[list.length - 1]!) : null;
  }
  async listPendingApprovalsByChannel(channel: ApprovalRow["channel"]) {
    return this.approvals.filter((a) => a.status === "pending" && a.channel === channel).map(clone);
  }
  async listPendingApprovalCandidates(q: { shortCodes: string[]; threadId: string | null; messageIds: string[] }) {
    const ids = new Set(q.messageIds.map(norm));
    const codes = new Set(q.shortCodes.map((c) => c.toUpperCase()));
    return this.approvals
      .filter((a) => a.status === "pending")
      .map((a) => {
        const job = this.jobs.get(a.job_id)!;
        return { ...clone(a), short_code: job.short_code, approver_email: job.approver_email ?? "" };
      })
      .filter((a) => codes.has(a.short_code) || (q.threadId !== null && a.thread_id === q.threadId) || (a.outbound_message_id !== null && ids.has(norm(a.outbound_message_id))));
  }
  async transitionApproval(id: string, from: ApprovalRow["status"], patch: Partial<ApprovalRow>) {
    const a = this.approvals.find((x) => x.id === id);
    if (!a || a.status !== from) return false;
    const bad = approvalUpdateViolation(a, patch); // parity with 121_engine_security2
    if (bad) throw new Error(bad);
    Object.assign(a, patch);
    return true;
  }
  async updateApproval(id: string, patch: Partial<ApprovalRow>) {
    const a = this.approvals.find((x) => x.id === id);
    const bad = a ? approvalUpdateViolation(a, patch) : null;
    if (bad) throw new Error(bad);
    if (a) Object.assign(a, patch);
  }
  async recordWrongApprovalCode(id: string, maxAttempts: number) {
    const a = this.approvals.find((x) => x.id === id);
    if (!a || a.status !== "pending") return null;
    a.attempts += 1;
    const locked = a.attempts >= maxAttempts;
    if (locked) Object.assign(a, { status: "locked", decided_at: now() });
    return { attempts: a.attempts, locked };
  }

  async insertPayment(p: Omit<PaymentRow, "created_at" | "updated_at">) {
    if (this.payments.some((x) => x.approval_id === p.approval_id)) return null;
    if (this.payments.some((x) => x.job_id === p.job_id && !["failed", "rejected", "expired"].includes(x.status))) return null;
    const row: PaymentRow = { ...clone(p), created_at: now(), updated_at: now() };
    this.payments.push(row);
    return clone(row);
  }
  async getPaymentForJob(jobId: string) {
    const list = this.payments.filter((p) => p.job_id === jobId);
    return list.length ? clone(list[list.length - 1]!) : null;
  }
  async transitionPayment(id: string, from: PaymentRow["status"][], patch: Partial<PaymentRow>) {
    const p = this.payments.find((x) => x.id === id);
    if (!p || !from.includes(p.status)) return null;
    if (patch.challenge_step_id && this.payments.some((x) => x.id !== id && x.challenge_step_id === patch.challenge_step_id)) return null;
    Object.assign(p, patch, { updated_at: now() });
    return clone(p);
  }

  async appendEvent(jobId: string, type: string, data: Record<string, unknown> = {}) {
    const seq = this.events.filter((e) => e.job_id === jobId).length + 1;
    const row: JobEventRow = { job_id: jobId, seq, type, data: clone(data), at: now() };
    this.events.push(row);
    return clone(row);
  }
  async listEvents(jobId: string, afterSeq = 0) {
    return this.events.filter((e) => e.job_id === jobId && e.seq > afterSeq).map(clone);
  }
  async recordInboundEvent(providerEventId: string) {
    if (this.inboundEvents.has(providerEventId)) return false;
    this.inboundEvents.add(providerEventId);
    return true;
  }

  async listRecentJobs(limit: number, workspaceId?: string) {
    return [...this.jobs.values()]
      .filter((j) => workspaceId === undefined || j.workspace_id === workspaceId)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.created_at.localeCompare(a.created_at)).slice(0, limit).map(clone);
  }
  async getSettings(workspaceId = DEFAULT_WORKSPACE_ID) {
    const s = this.settings.get(workspaceId);
    return s ? clone(s) : null;
  }
  async saveSettings(s: Omit<SettingsRow, "updated_at">, workspaceId = DEFAULT_WORKSPACE_ID) {
    const row = { ...clone(s), updated_at: now() };
    this.settings.set(workspaceId, row);
    return clone(row);
  }

  // text routing (migration 108): the same rules as the database, incl. the job-workspace trigger.
  private textRoutes: TextRouteRow[] = [];
  private held: HeldTextRow[] = [];
  private suppressionRemovals: SuppressionRemovalRow[] = [];
  private sameWorkspace(r: { job_id: string; workspace_id: string }) {
    if (this.jobs.get(r.job_id)?.workspace_id !== r.workspace_id) throw new Error("text row workspace must be its job's workspace");
  }
  async recordTextRoute(r: TextRouteRow) {
    this.sameWorkspace(r);
    if ((r.purpose === "business") !== (r.business_id !== null)) throw new Error("business route needs its business");
    this.textRoutes = this.textRoutes.filter((x) => !(x.line === r.line && x.remote === r.remote && x.job_id === r.job_id && x.purpose === r.purpose));
    this.textRoutes.push(clone(r));
  }
  async listTextRoutes(line: string, remote: string) {
    return this.textRoutes.filter((x) => x.line === line && x.remote === remote).sort((a, b) => b.last_out_at.localeCompare(a.last_out_at)).map(clone);
  }
  async holdText(h: Omit<HeldTextRow, "held_at">, keep: number) {
    this.sameWorkspace(h);
    const mine = (x: HeldTextRow) => x.line === h.line && x.remote === h.remote;
    this.held = this.held.filter((x) => !(mine(x) && x.key === h.key));
    this.held.push({ ...clone(h), held_at: now() });
    const forNumber = this.held.filter(mine);
    const drop = new Set(forNumber.slice(0, Math.max(0, forNumber.length - keep)));
    this.held = this.held.filter((x) => !drop.has(x));
  }
  async takeHeldTexts(line: string, remote: string) {
    const taken = this.held.filter((x) => x.line === line && x.remote === remote);
    this.held = this.held.filter((x) => !taken.includes(x));
    return taken.map(clone);
  }
  async isApprovalHeld(approvalId: string) {
    return this.held.some((x) => x.approval_id === approvalId);
  }
  async removeSuppression(contact: string, removedBy: string, why: string) {
    const s = this.suppressions.get(contact.toLowerCase());
    if (!s) return null;
    if (why.trim().length < 3 || !removedBy.trim()) throw new Error("a removal records who and why");
    this.suppressions.delete(s.contact);
    const r: SuppressionRemovalRow = { contact: s.contact, reason: s.reason, job_id: s.job_id, evidence: s.evidence, suppressed_at: s.created_at, removed_by: removedBy, why, removed_at: now() };
    this.suppressionRemovals.push(r);
    return clone(r);
  }
  async listWorkspacesByApproverPhone(phone: string) {
    return [...this.settings.entries()].filter(([, s]) => s.approver_phone === phone).map(([id]) => id).sort();
  }
  // reliability (migration 109)
  private reviews: OperatorReviewRow[] = [];
  private openReviewFor(kind: OperatorReviewRow["kind"], subject: string) {
    return this.reviews.find((r) => r.kind === kind && r.subject === subject && r.status === "open");
  }
  async renewJobLease(jobId: string, owner: string, now: string, ttlMs: number) {
    const cur = this.leases.get(jobId);
    if (cur?.owner !== owner) return false;
    this.leases.set(jobId, { owner, expires: Date.parse(now) + ttlMs });
    return true;
  }
  async listOutbox(q: { jobId?: string; statuses?: OutboxRow["status"][]; updatedBefore?: string; limit?: number }) {
    return [...this.outbox.values()]
      .filter((o) => (q.jobId === undefined || o.job_id === q.jobId) && (!q.statuses || q.statuses.includes(o.status)) && (!q.updatedBefore || o.updated_at < q.updatedBefore))
      .sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, q.limit ?? 500).map(clone);
  }
  async findOutboxByProviderRef(ref: string) {
    const r = [...this.outbox.values()].find((o) => o.provider_ref === ref);
    return r ? clone(r) : null;
  }
  async rearmOutbox(key: string, at: string) {
    const cur = this.outbox.get(key);
    if (!cur || cur.status === "sent" || (cur.kind === "call" && cur.status !== "not_sent")) return null;
    const next = { ...cur, status: "not_sent" as const, attempts: 1, updated_at: at };
    this.outbox.set(key, next);
    return clone(next);
  }
  async openReview(r: Pick<OperatorReviewRow, "id" | "job_id" | "kind" | "subject" | "reason" | "attempts" | "last_error">, at: string) {
    const cur = this.openReviewFor(r.kind, r.subject);
    if (cur) {
      Object.assign(cur, { reason: r.reason, attempts: Math.max(cur.attempts, r.attempts), last_error: r.last_error ?? cur.last_error, updated_at: at });
      return { row: clone(cur), created: false };
    }
    const row: OperatorReviewRow = { ...r, status: "open", resolution: null, resolved_by: null, resolved_at: null, created_at: at, updated_at: at };
    this.reviews.push(row);
    return { row: clone(row), created: true };
  }
  async findOpenReview(kind: OperatorReviewRow["kind"], subject: string) {
    const r = this.openReviewFor(kind, subject);
    return r ? clone(r) : null;
  }
  async getReview(id: string) {
    const r = this.reviews.find((x) => x.id === id);
    return r ? clone(r) : null;
  }
  async listReviews(q: { status?: OperatorReviewRow["status"]; jobId?: string; limit?: number }) {
    return this.reviews.filter((r) => (!q.status || r.status === q.status) && (q.jobId === undefined || r.job_id === q.jobId))
      .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, q.limit ?? 100).map(clone);
  }
  async resolveReview(id: string, r: { resolution: string; resolved_by: string }, at: string) {
    const cur = this.reviews.find((x) => x.id === id);
    if (!cur || cur.status !== "open") return null;
    Object.assign(cur, { status: "resolved", resolution: r.resolution, resolved_by: r.resolved_by, resolved_at: at, updated_at: at });
    return clone(cur);
  }
  // bookings and verified receipts (migration 110): the same rules as its triggers.
  private bookings: BookingRow[] = [];
  private receipts: HandoffReceiptRow[] = [];

  async insertBooking(b: Omit<BookingRow, "created_at" | "updated_at">) {
    if (this.bookings.some((x) => x.approval_id === b.approval_id)) return null;
    const a = this.approvals.find((x) => x.id === b.approval_id);
    // 113: a confirm-only approval books too (the business must confirm it in writing), paying nothing.
    if (!a || a.job_id !== b.job_id || a.quote_id !== b.quote_id || a.business_id !== b.business_id || a.quote_total_cents !== b.total_cents || a.payment_cents !== b.payment_cents || !["approved", "used"].includes(a.status)
      || (a.action === "confirm" ? b.payment_cents !== 0 : b.payment_cents <= 0) || b.total_cents <= 0) {
      throw new Error("booking must match a human-approved approval");
    }
    if (!["awaiting_vendor_confirmation", "not_in_writing"].includes(b.status)) throw new Error("a booking starts awaiting the business (or not in writing)");
    if (b.human_attested_at) throw new Error("a booking starts unattested");
    const row = { ...b, created_at: now(), updated_at: now() };
    this.bookings.push(row);
    return clone(row);
  }
  async getBookingByApproval(approvalId: string) {
    const b = this.bookings.find((x) => x.approval_id === approvalId);
    return b ? clone(b) : null;
  }
  async updateBooking(id: string, fromStatuses: BookingRow["status"][], patch: Partial<Pick<BookingRow, "status" | "request_message_id" | "reply_text" | "reply_message_id" | "reply_has_link" | "confirmed_at" | "stalled_at" | "cancel_reason" | "human_attested_at">>) {
    const i = this.bookings.findIndex((x) => x.id === id);
    const cur = this.bookings[i];
    if (!cur || !fromStatuses.includes(cur.status) || ["declined", "changed", "cancelled"].includes(cur.status)) return null;
    if (["confirmed", "not_in_writing"].includes(cur.status) && patch.status && patch.status !== cur.status && patch.status !== "cancelled") return null;
    // 118: the human's attestation is set once, only on a booking Haggle can't confirm in writing.
    if (patch.human_attested_at !== undefined && patch.human_attested_at !== (cur.human_attested_at ?? null) && (cur.human_attested_at || (patch.status ?? cur.status) !== "not_in_writing")) throw new Error("only a not_in_writing booking is attested by the human, once");
    this.bookings[i] = { ...cur, ...patch, updated_at: now() };
    return clone(this.bookings[i]!);
  }
  async markHandoffStalled(id: string, at: string) {
    const i = this.handoffs.findIndex((x) => x.id === id);
    const cur = this.handoffs[i];
    if (!cur || cur.stalled_at || !["instructions_requested", "instructions_received"].includes(cur.status)) return null;
    this.handoffs[i] = { ...cur, stalled_at: at, updated_at: now() };
    return clone(this.handoffs[i]!);
  }
  async insertHandoffReceipt(r: Omit<HandoffReceiptRow, "created_at">) {
    if (this.receipts.some((x) => x.handoff_id === r.handoff_id)) return null;
    const h = this.handoffs.find((x) => x.id === r.handoff_id);
    if (!h || h.job_id !== r.job_id || h.status !== "human_confirmed") throw new Error("a receipt is recorded only after the customer reported paying");
    const row = { ...r, created_at: now() };
    this.receipts.push(row);
    return clone(row);
  }
  async getHandoffReceipt(handoffId: string) {
    const r = this.receipts.find((x) => x.handoff_id === handoffId);
    return r ? clone(r) : null;
  }
  // inbound review (migration 112): the same rules as its constraints and triggers.
  private resolutions: QuarantineResolutionRow[] = [];
  async insertQuarantineResolution(r: Omit<QuarantineResolutionRow, "resolved_at">) {
    if (this.resolutions.some((x) => x.message_id === r.message_id)) return null;
    if (r.decision === "released" ? r.released_trust_reason !== "operator_verified" || !r.job_id || !r.business_id : r.released_trust_reason !== null) throw new Error("quarantine resolution check failed");
    if (r.resolved_by.trim().length < 2 || r.resolved_by.trim().length > 80 || r.verification.trim().length < 10 || r.verification.trim().length > 500) throw new Error("quarantine resolution check failed");
    const row = { ...clone(r), resolved_at: now() };
    this.resolutions.push(row);
    return clone(row);
  }
  async listQuarantineResolutions(q: { messageId?: string; jobId?: string; limit?: number }) {
    return this.resolutions.filter((r) => (q.messageId === undefined || r.message_id === q.messageId) && (q.jobId === undefined || r.job_id === q.jobId)).slice(-(q.limit ?? 200)).reverse().map(clone);
  }
  async listQuarantinedMessages(q: { jobId?: string; limit?: number }) {
    return this.messages.filter((m) => m.direction === "in" && (m.kind === "quarantine" || (m.kind === "reply" && m.sender_trusted !== true)) && (q.jobId === undefined || m.job_id === q.jobId))
      .slice(-(q.limit ?? 100)).reverse().map(clone);
  }
  // reconciler high-water marks (migration 117)
  private cursors = new Map<string, string>();
  async getReconcileCursor(scope: string, channel: ReconcileChannel) {
    return this.cursors.get(`${scope}|${channel}`) ?? null;
  }
  async advanceReconcileCursor(scope: string, channel: ReconcileChannel, at: string) {
    const k = `${scope}|${channel}`;
    const cur = this.cursors.get(k);
    if (!cur || Date.parse(at) > Date.parse(cur)) this.cursors.set(k, new Date(at).toISOString());
  }
  // operator actions (migration 119): append-only, the same checks as its constraints.
  private operatorActions: OperatorActionRow[] = [];
  async appendOperatorAction(a: Omit<OperatorActionRow, "at">) {
    const op = a.operator.trim().length;
    const why = a.reason.trim().length;
    if (op < 2 || op > 80 || why < 3 || why > 500 || JSON.stringify(a.detail).length > 4000 || (!a.workspace_id && !a.job_id && a.action !== "suppression_removed")) throw new Error("operator action check failed");
    if (this.operatorActions.some((x) => x.id === a.id)) throw new Error("duplicate operator action id");
    const row = { ...clone(a), at: now() };
    this.operatorActions.push(row);
    return clone(row);
  }
  async listOperatorActions(q: { workspaceId?: string; jobId?: string; actions?: OperatorAction[]; limit?: number }) {
    return this.operatorActions.filter((r) => (q.workspaceId === undefined || r.workspace_id === q.workspaceId) && (q.jobId === undefined || r.job_id === q.jobId) && (!q.actions || q.actions.includes(r.action)))
      .reverse().slice(0, q.limit ?? 200).map(clone);
  }
  // per-call AI usage (migration 122): append-only
  private aiUsage: AiUsageRow[] = [];
  async recordAiUsage(u: Omit<AiUsageRow, "id" | "at"> & { at?: string }) {
    this.aiUsage.push({ ...u, id: this.aiUsage.length + 1, at: u.at ?? now() });
  }
  async listAiUsage(q: { jobIds?: string[]; since?: string; until?: string }) {
    return this.aiUsage.filter((r) => (!q.jobIds || (r.job_id !== null && q.jobIds.includes(r.job_id))) && (!q.since || r.at >= q.since) && (!q.until || r.at < q.until)).map(clone);
  }
}
