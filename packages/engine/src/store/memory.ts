// In-memory Repository for tests and mock mode. Enforces the same uniqueness rules as
// supabase/migrations/100_engine_core.sql so tests exercise real invariants. Single-process only.
import { newId } from "../ids.ts";
import type {
  ApprovalRow,
  JobBusinessRow,
  JobEventRow,
  JobRow,
  MessageRow,
  NewMessage,
  PaymentRow,
  QuestionRow,
  QuoteRow,
  Repository,
  SettingsRow,
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
  private settings: SettingsRow | null = null;

  async insertJob(job: JobRow) {
    if (this.jobs.has(job.id)) throw new Error("duplicate job id");
    if (job.client_request_id && [...this.jobs.values()].some((j) => j.client_request_id === job.client_request_id)) throw new Error("duplicate client_request_id");
    if ([...this.jobs.values()].some((j) => j.short_code === job.short_code)) throw new Error("duplicate short_code");
    this.jobs.set(job.id, clone(job));
    return clone(job);
  }
  async getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? clone(j) : null;
  }
  async findJobByClientRequestId(id: string) {
    const j = [...this.jobs.values()].find((x) => x.client_request_id === id);
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
    return [...this.jobs.values()].filter((j) => !["paid", "cancelled", "failed"].includes(j.state)).map(clone);
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

  async insertMessage(m: NewMessage) {
    if (m.provider_email_id && this.messages.some((x) => x.provider_email_id === m.provider_email_id)) return null;
    if (m.idempotency_key && this.messages.some((x) => x.idempotency_key === m.idempotency_key)) return null;
    const row: MessageRow = { ...clone(m), channel: m.channel ?? "email", id: newId("msg"), created_at: now() };
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
    if (m) Object.assign(m, patch);
  }
  async listMessages(jobId: string) {
    return this.messages.filter((m) => m.job_id === jobId).map(clone);
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
    Object.assign(a, patch);
    return true;
  }
  async updateApproval(id: string, patch: Partial<ApprovalRow>) {
    const a = this.approvals.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
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

  async listRecentJobs(limit: number) {
    return [...this.jobs.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.created_at.localeCompare(a.created_at)).slice(0, limit).map(clone);
  }
  async getSettings() {
    return this.settings ? clone(this.settings) : null;
  }
  async saveSettings(s: Omit<SettingsRow, "updated_at">) {
    this.settings = { ...clone(s), updated_at: now() };
    return clone(this.settings);
  }
}
