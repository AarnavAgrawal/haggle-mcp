// Postgres Repository (live mode) over supabase/migrations/100_engine_core.sql + 101_engine_channels.sql. Uses a direct
// Postgres connection (Supabase pooler URL, role with BYPASSRLS) so multi-statement operations run
// in real transactions; the database re-checks every safety invariant on its own.
import postgres from "postgres";
import { newId } from "../ids.ts";
import type {
  ApprovalRow, JobBusinessRow, JobEventRow, JobRow, MessageRow, NewMessage, PaymentRow, QuestionRow, QuoteRow, Repository, SettingsRow,
} from "./types.ts";

type Sql = postgres.Sql<Record<string, never>>;

const JSON_COLS = new Set(["request", "references", "attachments", "record", "requirement_results", "data"]);
const norm = (id: string) => id.trim().replace(/^<|>$/g, "").toLowerCase();

/** Timestamps -> ISO strings; everything else as-is. */
function row<T>(r: Record<string, unknown> | undefined): T | null {
  if (!r) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = v instanceof Date ? v.toISOString() : v;
  return out as T;
}
const rows = <T>(rs: readonly Record<string, unknown>[]): T[] => rs.map((r) => row<T>(r)!);
/** bigint columns come back from postgres.js as strings; cents are always numbers in the engine. */
const settingsRow = (s: SettingsRow | null): SettingsRow | null => (s ? { ...s, spending_cap_cents: Number(s.spending_cap_cents) } : null);

export class PostgresRepository implements Repository {
  private readonly sql: Sql;

  /** `schema`: where the migrations were applied when not `public` (a database shared with another app). */
  constructor(url: string, opts: { max?: number; schema?: string } = {}) {
    if (opts.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error(`invalid database schema name: ${opts.schema}`);
    this.sql = postgres(url, {
      max: opts.max ?? 5, idle_timeout: 20, connect_timeout: 15, prepare: false, onnotice: () => {},
      ...(opts.schema ? { connection: { search_path: opts.schema } } : {}),
    }) as unknown as Sql;
  }

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  /** Values for an INSERT/UPDATE: JSON columns serialised explicitly. */
  private vals(o: Record<string, unknown>) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      out[k] = JSON_COLS.has(k) ? this.sql.json(v as never) : v;
    }
    return out;
  }

  async insertJob(job: JobRow) {
    const r = await this.sql`insert into jobs ${this.sql(this.vals(job as never))} returning *`;
    return row<JobRow>(r[0])!;
  }
  async getJob(id: string) {
    return row<JobRow>((await this.sql`select * from jobs where id = ${id}`)[0]);
  }
  async findJobByClientRequestId(id: string) {
    return row<JobRow>((await this.sql`select * from jobs where client_request_id = ${id}`)[0]);
  }
  async findJobByShortCode(code: string) {
    return row<JobRow>((await this.sql`select * from jobs where short_code = ${code.toUpperCase()}`)[0]);
  }
  async casJob(id: string, expectedVersion: number, patch: Partial<JobRow>) {
    const { id: _i, version: _v, ...rest } = patch;
    const set = this.vals({ ...rest, updated_at: new Date() });
    const r = await this.sql`update jobs set ${this.sql(set)}, version = version + 1 where id = ${id} and version = ${expectedVersion} returning *`;
    return row<JobRow>(r[0]);
  }
  async touchJob(id: string, patch: Partial<JobRow> = {}) {
    const { id: _i, version: _v, ...rest } = patch;
    const set = this.vals({ ...rest, updated_at: new Date() });
    const r = await this.sql`update jobs set ${this.sql(set)}, version = version + 1 where id = ${id} returning *`;
    return row<JobRow>(r[0]);
  }
  async listOpenJobs() {
    return rows<JobRow>(await this.sql`select * from jobs where state not in ('paid','cancelled','failed') order by created_at`);
  }

  async insertBusinesses(list: JobBusinessRow[]) {
    if (list.length === 0) return;
    await this.sql`insert into job_businesses ${this.sql(list.map((b) => this.vals(b as never)) as never)}`;
  }
  async getBusinesses(jobId: string) {
    return rows<JobBusinessRow>(await this.sql`select * from job_businesses where job_id = ${jobId} order by name`);
  }
  async updateBusiness(jobId: string, businessId: string, patch: Partial<JobBusinessRow>, opts: { ifStatus?: JobBusinessRow["status"][] } = {}) {
    const { business_id: _a, name: _b, email: _c, job_id: _d, phone: _e, ...rest } = patch;
    const set = this.vals(rest);
    if (Object.keys(set).length === 0) return;
    if (opts.ifStatus) {
      await this.sql`update job_businesses set ${this.sql(set)} where job_id = ${jobId} and business_id = ${businessId} and status in ${this.sql(opts.ifStatus)}`;
      return;
    }
    await this.sql`update job_businesses set ${this.sql(set)} where job_id = ${jobId} and business_id = ${businessId}`;
  }
  async findBusinessCandidates(q: { shortCodes: string[]; threadId: string | null; messageIds: string[] }) {
    const ids = q.messageIds.map(norm);
    const codes = q.shortCodes.map((c) => c.toUpperCase());
    return rows<JobBusinessRow & { short_code: string }>(await this.sql`
      select b.*, j.short_code from job_businesses b join jobs j on j.id = b.job_id
      where j.short_code = any(${codes})
         or (${q.threadId}::text is not null and b.thread_id = ${q.threadId})
         or lower(btrim(b.rfq_message_id, '<>')) = any(${ids})
         or exists (select 1 from messages m where m.direction = 'out' and m.job_id = b.job_id and m.business_id = b.business_id
                    and lower(btrim(m.rfc_message_id, '<>')) = any(${ids}))`);
  }

  async insertMessage(m: NewMessage) {
    const r = await this.sql`insert into messages ${this.sql(this.vals({ ...m, id: newId("msg") }))} on conflict do nothing returning *`;
    return row<MessageRow>(r[0]);
  }
  async findMessageByIdempotencyKey(key: string) {
    return row<MessageRow>((await this.sql`select * from messages where idempotency_key = ${key}`)[0]);
  }
  async findMessageByProviderId(providerId: string) {
    return row<MessageRow>((await this.sql`select * from messages where provider_email_id = ${providerId}`)[0]);
  }
  async getMessage(id: string) {
    return row<MessageRow>((await this.sql`select * from messages where id = ${id}`)[0]);
  }
  async updateMessage(id: string, patch: Partial<MessageRow>) {
    const { id: _i, ...rest } = patch;
    const set = this.vals(rest);
    if (Object.keys(set).length) await this.sql`update messages set ${this.sql(set)} where id = ${id}`;
  }
  async listMessages(jobId: string) {
    return rows<MessageRow>(await this.sql`select * from messages where job_id = ${jobId} order by created_at, id`);
  }
  async listJobBusinessesByContact(c: { email?: string | null; phone?: string | null }) {
    if (!c.email && !c.phone) return [];
    return rows<JobBusinessRow>(await this.sql`select * from job_businesses where (${c.email ?? null}::text is not null and email = ${c.email ?? null}) or (${c.phone ?? null}::text is not null and phone = ${c.phone ?? null}) order by job_id limit 500`);
  }
  async listMessagesForBusiness(businessId: string) {
    return rows<MessageRow>(await this.sql`select * from messages where business_id = ${businessId} order by created_at, id limit 500`);
  }
  async getPendingMessages(jobId: string) {
    return rows<MessageRow>(await this.sql`select * from messages where job_id = ${jobId} and parse_status = 'pending' order by created_at, id`);
  }
  async findOutboundByRfcIds(ids: string[]) {
    return rows<MessageRow>(await this.sql`select * from messages where direction = 'out' and lower(btrim(rfc_message_id, '<>')) = any(${ids.map(norm)})`);
  }

  async insertCurrentQuote(q: Omit<QuoteRow, "id" | "created_at" | "status">) {
    return this.sql.begin(async (tx) => {
      const t = tx as unknown as Sql;
      const exists = await t`select 1 from quotes where message_id = ${q.message_id}`;
      if (exists.length) return null;
      await t`update quotes set status = 'superseded' where job_id = ${q.job_id} and business_id = ${q.business_id} and status = 'current'`;
      const r = await t`insert into quotes ${t(this.vals({ ...q, id: newId("q"), status: "current" }))} on conflict (message_id) do nothing returning *`;
      return row<QuoteRow>(r[0]);
    }) as Promise<QuoteRow | null>;
  }
  async getQuote(id: string) {
    return row<QuoteRow>((await this.sql`select * from quotes where id = ${id}`)[0]);
  }
  async listQuotes(jobId: string) {
    return rows<QuoteRow>(await this.sql`select * from quotes where job_id = ${jobId} order by created_at, id`);
  }
  async listQuotesForBusiness(businessId: string) {
    return rows<QuoteRow>(await this.sql`select * from quotes where business_id = ${businessId} order by created_at, id limit 500`);
  }

  async insertQuestion(q: Omit<QuestionRow, "id" | "created_at" | "status" | "answer" | "answered_at">) {
    const r = await this.sql`insert into questions ${this.sql(this.vals({ ...q, id: newId("qn"), status: "pending" }))} returning *`;
    return row<QuestionRow>(r[0])!;
  }
  async getQuestion(id: string) {
    return row<QuestionRow>((await this.sql`select * from questions where id = ${id}`)[0]);
  }
  async listQuestions(jobId: string) {
    return rows<QuestionRow>(await this.sql`select * from questions where job_id = ${jobId} order by created_at, id`);
  }
  async answerQuestion(id: string, answer: string) {
    const r = await this.sql`update questions set status = 'answered', answer = ${answer}, answered_at = now() where id = ${id} and status = 'pending' returning id`;
    return r.length > 0;
  }

  async insertApproval(a: Omit<ApprovalRow, "created_at">) {
    const r = await this.sql`insert into approvals ${this.sql(this.vals(a as never))} on conflict do nothing returning *`;
    return row<ApprovalRow>(r[0]);
  }
  async getApproval(id: string) {
    return row<ApprovalRow>((await this.sql`select * from approvals where id = ${id}`)[0]);
  }
  async getLatestApproval(jobId: string) {
    return row<ApprovalRow>((await this.sql`select * from approvals where job_id = ${jobId} order by created_at desc, id desc limit 1`)[0]);
  }
  async listPendingApprovalsByChannel(channel: ApprovalRow["channel"]) {
    return rows<ApprovalRow>(await this.sql`select * from approvals where status = 'pending' and channel = ${channel} order by created_at desc`);
  }
  async listPendingApprovalCandidates(q: { shortCodes: string[]; threadId: string | null; messageIds: string[] }) {
    const ids = q.messageIds.map(norm);
    const codes = q.shortCodes.map((c) => c.toUpperCase());
    return rows<ApprovalRow & { short_code: string; approver_email: string }>(await this.sql`
      select a.*, j.short_code, coalesce(j.approver_email, '') as approver_email from approvals a join jobs j on j.id = a.job_id
      where a.status = 'pending' and (j.short_code = any(${codes})
         or (${q.threadId}::text is not null and a.thread_id = ${q.threadId})
         or lower(btrim(a.outbound_message_id, '<>')) = any(${ids}))`);
  }
  async transitionApproval(id: string, from: ApprovalRow["status"], patch: Partial<ApprovalRow>) {
    const { id: _i, ...rest } = patch;
    const r = await this.sql`update approvals set ${this.sql(this.vals(rest))} where id = ${id} and status = ${from} returning id`;
    return r.length > 0;
  }
  async updateApproval(id: string, patch: Partial<ApprovalRow>) {
    const { id: _i, ...rest } = patch;
    const set = this.vals(rest);
    if (Object.keys(set).length) await this.sql`update approvals set ${this.sql(set)} where id = ${id}`;
  }

  async insertPayment(p: Omit<PaymentRow, "created_at" | "updated_at">) {
    const r = await this.sql`insert into payments ${this.sql(this.vals(p as never))} on conflict do nothing returning *`;
    return row<PaymentRow>(r[0]);
  }
  async getPaymentForJob(jobId: string) {
    return row<PaymentRow>((await this.sql`select * from payments where job_id = ${jobId} order by created_at desc, id desc limit 1`)[0]);
  }
  async transitionPayment(id: string, from: PaymentRow["status"][], patch: Partial<PaymentRow>) {
    const { id: _i, ...rest } = patch;
    try {
      const r = await this.sql`update payments set ${this.sql(this.vals({ ...rest, updated_at: new Date() }))} where id = ${id} and status = any(${from}) returning *`;
      return row<PaymentRow>(r[0]);
    } catch (e) {
      // A database invariant refused the transition (e.g. duplicate challenge step): treat as not applied.
      if ((e as { code?: string }).code === "23505" || (e as { code?: string }).code === "23514" || (e as { code?: string }).code === "P0001") return null;
      throw e;
    }
  }

  async appendEvent(jobId: string, type: string, data: Record<string, unknown> = {}) {
    const r = await this.sql`select haggle_append_event(${jobId}, ${type}, ${this.sql.json(data as never)}) as seq`;
    const seq = Number(r[0]!.seq);
    return { job_id: jobId, seq, type, data, at: new Date().toISOString() } satisfies JobEventRow;
  }
  async listEvents(jobId: string, afterSeq = 0) {
    return rows<JobEventRow>(await this.sql`select * from job_events where job_id = ${jobId} and seq > ${afterSeq} order by seq`);
  }
  async recordInboundEvent(providerEventId: string) {
    const r = await this.sql`insert into inbound_events (provider_event_id) values (${providerEventId}) on conflict do nothing returning provider_event_id`;
    return r.length > 0;
  }

  async listRecentJobs(limit: number) {
    return rows<JobRow>(await this.sql`select * from jobs order by updated_at desc, created_at desc limit ${limit}`);
  }
  async getSettings() {
    return settingsRow(row<SettingsRow>((await this.sql`select spending_cap_cents, approver_phone, approver_email, default_area, updated_at from engine_settings where id = 1`)[0]));
  }
  async saveSettings(s: Omit<SettingsRow, "updated_at">) {
    const r = await this.sql`
      insert into engine_settings (id, spending_cap_cents, approver_phone, approver_email, default_area, updated_at)
      values (1, ${s.spending_cap_cents}, ${s.approver_phone}, ${s.approver_email}, ${s.default_area}, now())
      on conflict (id) do update set spending_cap_cents = excluded.spending_cap_cents, approver_phone = excluded.approver_phone,
        approver_email = excluded.approver_email, default_area = excluded.default_area, updated_at = now()
      returning spending_cap_cents, approver_phone, approver_email, default_area, updated_at`;
    return settingsRow(row<SettingsRow>(r[0]))!;
  }
}
