// Postgres Repository (live mode) over supabase/migrations/100_engine_core.sql + 101_engine_channels.sql. Uses a direct
// Postgres connection (Supabase pooler URL, role with BYPASSRLS) so multi-statement operations run
// in real transactions; the database re-checks every safety invariant on its own.
import postgres from "postgres";
import { newId } from "../ids.ts";
import { isTransient } from "../live/transient.ts";
import { gatedSql, PoolGate, type PoolStats } from "./poolGate.ts";
import {
  DEFAULT_WORKSPACE_ID, type ApprovalRow, type JobBusinessRow, type JobEventRow, type JobRow, type MessageRow, type NewMessage, type PaymentRow, type QuestionRow, type QuoteRow, type Repository, type SettingsRow, type WorkspaceRow, type OutboxRow, type SuppressionRow, type WorkspaceVendorRow, type PaymentHandoffRow, type OperatorReviewRow, type TextRouteRow, type HeldTextRow, type SuppressionRemovalRow, type BookingRow, type HandoffReceiptRow, type QuarantineResolutionRow, type ReconcileChannel, type OperatorActionRow, type OperatorAction,
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
/** payment_handoffs.amount_cents is bigint (106): a number in the engine, never a string. */
const handoffRow = (r: Record<string, unknown> | undefined): PaymentHandoffRow | null => { const h = row<PaymentHandoffRow>(r); return h ? { ...h, amount_cents: Number(h.amount_cents) } : null; };

/** A tagged-template query that only reads (a plain SELECT, not the event-appending function). */
const isReadTemplate = (s: unknown): boolean =>
  Array.isArray(s) && "raw" in (s as object) && /^\s*select\b/i.test(String((s as string[])[0])) && !(s as string[]).join("").includes("haggle_append_event");

/**
 * One retry, after a short pause, for a plain SELECT that hit a transient connection error
 * (EMAXCONNSESSION while the pooler is full, a reset socket, a connect timeout): reads are
 * idempotent. Writes are never retried here (their callers are idempotent by key instead).
 * Everything else (sql(obj) helpers, sql.json, sql.begin, sql.end) passes straight through.
 */
export function retryingReads(sql: Sql, delayMs = 300): Sql {
  const call = (first: unknown, ...rest: unknown[]) => {
    const run = () => (sql as unknown as (...a: unknown[]) => PromiseLike<unknown>)(first, ...rest);
    if (!isReadTemplate(first)) return run();
    return {
      then<A, B>(ok?: (v: unknown) => A | PromiseLike<A>, fail?: (e: unknown) => B | PromiseLike<B>) {
        return Promise.resolve(run())
          .catch(async (e) => {
            if (!isTransient(e)) throw e;
            await new Promise((r) => setTimeout(r, delayMs));
            return run();
          })
          .then(ok, fail);
      },
    };
  };
  return new Proxy(call, {
    get(_t, p) {
      const v = Reflect.get(sql as object, p);
      return typeof v === "function" ? v.bind(sql) : v;
    },
  }) as unknown as Sql;
}

export class PostgresRepository implements Repository {
  private readonly sql: Sql;

  /** Connection-slot accounting for this repository's pool (store/poolGate.ts). */
  private readonly gate: PoolGate;

  /**
   * `schema`: where the migrations were applied when not `public` (a database shared with another app).
   * `queueTimeoutMs`: how long a query waits for a free pooled connection before failing as transient
   * (PoolBusyError); `maxQueue`: waiters beyond this fail at once. `applicationName` shows in pg_stat_activity.
   */
  constructor(url: string, opts: { max?: number; schema?: string; retryDelayMs?: number; queueTimeoutMs?: number; maxQueue?: number; applicationName?: string } = {}) {
    if (opts.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error(`invalid database schema name: ${opts.schema}`);
    const max = opts.max ?? 4;
    // Small pool, idle connections released after 20 s, recycled after 30 min: Supabase's session
    // pooler caps clients per database (15), shared by every process and reload. The gate bounds the
    // wait for one of them, so polling boards can't queue without limit behind a saturated pool.
    this.gate = new PoolGate(max, opts.queueTimeoutMs ?? 5_000, opts.maxQueue ?? 500);
    this.sql = retryingReads(gatedSql(postgres(url, {
      max, idle_timeout: 20, max_lifetime: 30 * 60, connect_timeout: 15, prepare: false, onnotice: () => {},
      connection: { application_name: (opts.applicationName ?? "haggle-engine").slice(0, 63), ...(opts.schema ? { search_path: opts.schema } : {}) },
    }) as unknown as Sql, this.gate), opts.retryDelayMs ?? 300);
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

  async insertWorkspace(w: Omit<WorkspaceRow, "created_at">) {
    const r = await this.sql`insert into workspaces ${this.sql(this.vals(w as never))} returning id, name, token_hash, connector_secret_hash, timezone, created_at`;
    return row<WorkspaceRow>(r[0])!;
  }
  async getWorkspace(id: string) {
    return row<WorkspaceRow>((await this.sql`select id, name, token_hash, connector_secret_hash, timezone, revoked_at, created_at from workspaces where id = ${id}`)[0]);
  }
  async findWorkspaceByTokenHash(hash: string) {
    return row<WorkspaceRow>((await this.sql`select id, name, token_hash, connector_secret_hash, timezone, revoked_at, created_at from workspaces where token_hash = ${hash} and revoked_at is null`)[0]);
  }
  async findWorkspaceBySecretHash(hash: string) {
    return row<WorkspaceRow>((await this.sql`select id, name, token_hash, connector_secret_hash, timezone, revoked_at, created_at from workspaces where connector_secret_hash = ${hash} and revoked_at is null`)[0]);
  }
  async acquireJobLease(jobId: string, owner: string, now: string, ttlMs: number) {
    const until = new Date(Date.parse(now) + ttlMs).toISOString();
    const r = await this.sql`
      insert into job_leases (job_id, owner, expires_at) values (${jobId}, ${owner}, ${until})
      on conflict (job_id) do update set owner = excluded.owner, expires_at = excluded.expires_at
      where job_leases.expires_at < ${now} or job_leases.owner = excluded.owner
      returning job_id`;
    return r.length > 0;
  }
  async releaseJobLease(jobId: string, owner: string) {
    await this.sql`delete from job_leases where job_id = ${jobId} and owner = ${owner}`;
  }
  async claimOutbox(o: { key: string; job_id: string | null; kind: OutboxRow["kind"] }, now: string) {
    const ins = await this.sql`insert into outbox (key, job_id, kind, status, created_at, updated_at) values (${o.key}, ${o.job_id}, ${o.kind}, 'pending', ${now}, ${now}) on conflict (key) do nothing returning *`;
    if (ins.length) return { fresh: true, row: row<OutboxRow>(ins[0])! };
    return { fresh: false, row: row<OutboxRow>((await this.sql`select * from outbox where key = ${o.key}`)[0])! };
  }
  async reclaimOutbox(key: string, fromStatuses: OutboxRow["status"][], now: string) {
    const r = await this.sql`
      update outbox set status = 'pending', attempts = attempts + 1, updated_at = ${now}
      where key = ${key} and status = any(${fromStatuses}) and (kind <> 'call' or status = 'not_sent') returning *`;
    return row<OutboxRow>(r[0]);
  }
  async finishOutbox(key: string, status: Exclude<OutboxRow["status"], "pending">, providerRef: string | null, now: string) {
    await this.sql`update outbox set status = ${status}, provider_ref = coalesce(${providerRef}, provider_ref), updated_at = ${now} where key = ${key} and status <> 'sent'`;
  }
  async getOutbox(key: string) {
    return row<OutboxRow>((await this.sql`select * from outbox where key = ${key}`)[0]);
  }
  async addSuppression(s: Omit<SuppressionRow, "created_at">) {
    await this.sql`insert into vendor_suppressions ${this.sql(this.vals(s as never))} on conflict (contact) do nothing`;
  }
  async findSuppressions(contacts: string[]) {
    if (!contacts.length) return [];
    return rows<SuppressionRow>(await this.sql`select * from vendor_suppressions where contact = any(${contacts.map((c) => c.toLowerCase())})`);
  }
  async addWorkspaceVendor(v: Omit<WorkspaceVendorRow, "created_at">) {
    const r = await this.sql`
      insert into workspace_vendors ${this.sql(this.vals({ ...v, channel: v.channel ?? null } as never))}
      on conflict (workspace_id, contact) do update set name = excluded.name, consent = excluded.consent, added_by = excluded.added_by, channel = excluded.channel
      returning *`;
    return row<WorkspaceVendorRow>(r[0])!;
  }
  async removeWorkspaceVendor(workspaceId: string, contact: string) {
    return (await this.sql`delete from workspace_vendors where workspace_id = ${workspaceId} and contact = ${contact} returning contact`).length > 0;
  }
  async listWorkspaceVendors(workspaceId: string) {
    return rows<WorkspaceVendorRow>(await this.sql`select * from workspace_vendors where workspace_id = ${workspaceId} order by created_at`);
  }
  async insertHandoff(h: Omit<PaymentHandoffRow, "created_at" | "updated_at">) {
    const r = await this.sql`insert into payment_handoffs ${this.sql(this.vals(h as never))} on conflict (approval_id) do nothing returning *`;
    return handoffRow(r[0]);
  }
  async getHandoffByApproval(approvalId: string) {
    return handoffRow((await this.sql`select * from payment_handoffs where approval_id = ${approvalId}`)[0]);
  }
  async updateHandoff(id: string, fromStatuses: PaymentHandoffRow["status"][], patch: Partial<Pick<PaymentHandoffRow, "status" | "instructions_text" | "instructions_message_id" | "confirmed_by" | "confirmed_at">>) {
    const r = await this.sql`update payment_handoffs set ${this.sql(this.vals({ ...patch, updated_at: new Date().toISOString() } as never))} where id = ${id} and status = any(${fromStatuses}) returning *`;
    return handoffRow(r[0]);
  }
  async setWorkspaceCredentials(id: string, c: { token_hash?: string | null; connector_secret_hash?: string | null; revoked: boolean }) {
    const r = await this.sql`
      update workspaces set token_hash = ${c.token_hash === undefined ? this.sql`token_hash` : c.token_hash}, connector_secret_hash = ${c.connector_secret_hash === undefined ? this.sql`connector_secret_hash` : c.connector_secret_hash},
        revoked_at = ${c.revoked ? this.sql`now()` : null}
      where id = ${id} returning id, name, token_hash, connector_secret_hash, timezone, revoked_at, created_at`;
    return row<WorkspaceRow>(r[0]);
  }

  async insertJob(job: JobRow) {
    const r = await this.sql`insert into jobs ${this.sql(this.vals(job as never))} returning *`;
    return row<JobRow>(r[0])!;
  }
  async getJob(id: string) {
    return row<JobRow>((await this.sql`select * from jobs where id = ${id}`)[0]);
  }
  async findJobByClientRequestId(id: string, workspaceId = DEFAULT_WORKSPACE_ID) {
    return row<JobRow>((await this.sql`select * from jobs where workspace_id = ${workspaceId} and client_request_id = ${id}`)[0]);
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
    return rows<JobRow>(await this.sql`select * from jobs where state not in ('paid','confirmed','cancelled','failed') order by created_at`);
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
    // One indexed lookup per way of matching (an OR across the join scanned every job_businesses row; 117).
    return rows<JobBusinessRow & { short_code: string }>(await this.sql`
      select b.*, j.short_code from job_businesses b join jobs j on j.id = b.job_id where j.short_code = any(${codes})
      union select b.*, (select short_code from jobs where id = b.job_id) from job_businesses b where b.thread_id = ${q.threadId}
      union select b.*, (select short_code from jobs where id = b.job_id) from job_businesses b where lower(btrim(b.rfq_message_id, '<>')) = any(${ids})
      union select b.*, (select short_code from jobs where id = b.job_id) from messages m join job_businesses b on b.job_id = m.job_id and b.business_id = m.business_id
        where m.direction = 'out' and lower(btrim(m.rfc_message_id, '<>')) = any(${ids})`);
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
  async listPhoneMessages(number: string, sinceIso: string) {
    return rows<MessageRow>(await this.sql`
      select * from messages where channel = 'phone' and created_at >= ${sinceIso}
        and ((direction = 'out' and to_address = ${number}) or (direction = 'in' and from_address = ${number}))
      order by created_at, id`);
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
  async recordWrongApprovalCode(id: string, maxAttempts: number) {
    const r = await this.sql`
      update approvals set attempts = attempts + 1,
        status = case when attempts + 1 >= ${maxAttempts} then 'locked' else status end,
        decided_at = case when attempts + 1 >= ${maxAttempts} then now() else decided_at end
      where id = ${id} and status = 'pending' returning attempts, status`;
    return r[0] ? { attempts: Number(r[0].attempts), locked: r[0].status === "locked" } : null;
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

  async listRecentJobs(limit: number, workspaceId?: string) {
    return workspaceId === undefined
      ? rows<JobRow>(await this.sql`select * from jobs order by updated_at desc, created_at desc limit ${limit}`)
      : rows<JobRow>(await this.sql`select * from jobs where workspace_id = ${workspaceId} order by updated_at desc, created_at desc limit ${limit}`);
  }
  /** Settings live on the workspace row (migration 103 moved engine_settings id=1 to ws_default). */
  async getSettings(workspaceId = DEFAULT_WORKSPACE_ID) {
    return settingsRow(row<SettingsRow>((await this.sql`
      select spending_cap_cents, approver_phone, approver_email, default_area, settings_updated_at as updated_at
      from workspaces where id = ${workspaceId} and spending_cap_cents is not null`)[0]));
  }
  async saveSettings(s: Omit<SettingsRow, "updated_at">, workspaceId = DEFAULT_WORKSPACE_ID) {
    const r = await this.sql`
      update workspaces set spending_cap_cents = ${s.spending_cap_cents}, approver_phone = ${s.approver_phone}, approver_email = ${s.approver_email},
        default_area = ${s.default_area}, settings_updated_at = now()
      where id = ${workspaceId}
      returning spending_cap_cents, approver_phone, approver_email, default_area, settings_updated_at as updated_at`;
    if (!r[0]) throw new Error(`unknown workspace ${workspaceId}`);
    return settingsRow(row<SettingsRow>(r[0]))!;
  }

  // text routing (migration 108)
  async recordTextRoute(r: TextRouteRow) {
    await this.sql`
      insert into text_routes ${this.sql(this.vals(r as never))}
      on conflict (line, remote, job_id, purpose) do update set business_id = excluded.business_id, question_id = excluded.question_id,
        approval_id = excluded.approval_id, last_out_at = greatest(text_routes.last_out_at, excluded.last_out_at), workspace_id = excluded.workspace_id`;
  }
  async listTextRoutes(line: string, remote: string) {
    return rows<TextRouteRow>(await this.sql`select * from text_routes where line = ${line} and remote = ${remote} order by last_out_at desc`);
  }
  async holdText(h: Omit<HeldTextRow, "held_at">, keep: number) {
    await this.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      await tx`
        insert into held_texts ${tx(this.vals(h as never))}
        on conflict (line, remote, key) do update set text = excluded.text, question_id = excluded.question_id, approval_id = excluded.approval_id, held_at = now()`;
      await tx`
        delete from held_texts where line = ${h.line} and remote = ${h.remote} and key not in (
          select key from held_texts where line = ${h.line} and remote = ${h.remote} order by held_at desc, key desc limit ${keep})`;
    });
  }
  async takeHeldTexts(line: string, remote: string) {
    return rows<HeldTextRow>(await this.sql`delete from held_texts where line = ${line} and remote = ${remote} returning *`).sort((a, b) => a.held_at.localeCompare(b.held_at));
  }
  async isApprovalHeld(approvalId: string) {
    return (await this.sql`select 1 from held_texts where approval_id = ${approvalId} limit 1`).length > 0;
  }
  async removeSuppression(contact: string, removedBy: string, why: string) {
    const r = await this.sql`
      with d as (delete from vendor_suppressions where contact = ${contact.toLowerCase()} returning *)
      insert into suppression_removals (contact, reason, job_id, evidence, suppressed_at, removed_by, why)
      select contact, reason, job_id, evidence, created_at, ${removedBy}, ${why} from d
      returning contact, reason, job_id, evidence, suppressed_at, removed_by, why, removed_at`;
    return row<SuppressionRemovalRow>(r[0]);
  }
  async listWorkspacesByApproverPhone(phone: string) {
    return (await this.sql`select id from workspaces where approver_phone = ${phone} order by id`).map((r) => String(r.id));
  }
  // reliability (migration 109)
  async renewJobLease(jobId: string, owner: string, now: string, ttlMs: number) {
    const until = new Date(Date.parse(now) + ttlMs).toISOString();
    return (await this.sql`update job_leases set expires_at = ${until} where job_id = ${jobId} and owner = ${owner} returning job_id`).length > 0;
  }
  async listOutbox(q: { jobId?: string; statuses?: OutboxRow["status"][]; updatedBefore?: string; limit?: number }) {
    const s = this.sql;
    return rows<OutboxRow>(await s`
      select * from outbox where true
        ${q.jobId !== undefined ? s`and job_id = ${q.jobId}` : s``}
        ${q.statuses ? s`and status = any(${q.statuses})` : s``}
        ${q.updatedBefore ? s`and updated_at < ${q.updatedBefore}` : s``}
      order by created_at limit ${q.limit ?? 500}`);
  }
  async findOutboxByProviderRef(ref: string) {
    return row<OutboxRow>((await this.sql`select * from outbox where provider_ref = ${ref} limit 1`)[0]);
  }
  async rearmOutbox(key: string, now: string) {
    const r = await this.sql`
      update outbox set status = 'not_sent', attempts = 1, updated_at = ${now}
      where key = ${key} and status <> 'sent' and (kind <> 'call' or status = 'not_sent') returning *`;
    return row<OutboxRow>(r[0]);
  }
  async openReview(r: Pick<OperatorReviewRow, "id" | "job_id" | "kind" | "subject" | "reason" | "attempts" | "last_error">, now: string) {
    const x = await this.sql`
      insert into operator_reviews (id, job_id, kind, subject, reason, attempts, last_error, status, created_at, updated_at)
      values (${r.id}, ${r.job_id}, ${r.kind}, ${r.subject}, ${r.reason}, ${r.attempts}, ${r.last_error}, 'open', ${now}, ${now})
      on conflict (kind, subject) where status = 'open' do update set
        reason = excluded.reason, attempts = greatest(operator_reviews.attempts, excluded.attempts),
        last_error = coalesce(excluded.last_error, operator_reviews.last_error), updated_at = excluded.updated_at
      returning *, (xmax = 0) as created`;
    const { created, ...rest } = x[0] as Record<string, unknown>;
    return { row: row<OperatorReviewRow>(rest)!, created: created === true };
  }
  async findOpenReview(kind: OperatorReviewRow["kind"], subject: string) {
    return row<OperatorReviewRow>((await this.sql`select * from operator_reviews where kind = ${kind} and subject = ${subject} and status = 'open'`)[0]);
  }
  async getReview(id: string) {
    return row<OperatorReviewRow>((await this.sql`select * from operator_reviews where id = ${id}`)[0]);
  }
  async listReviews(q: { status?: OperatorReviewRow["status"]; jobId?: string; limit?: number }) {
    const s = this.sql;
    return rows<OperatorReviewRow>(await s`
      select * from operator_reviews where true
        ${q.status ? s`and status = ${q.status}` : s``}
        ${q.jobId !== undefined ? s`and job_id = ${q.jobId}` : s``}
      order by created_at desc limit ${q.limit ?? 100}`);
  }
  async resolveReview(id: string, r: { resolution: string; resolved_by: string }, now: string) {
    const x = await this.sql`
      update operator_reviews set status = 'resolved', resolution = ${r.resolution.slice(0, 500)}, resolved_by = ${r.resolved_by.slice(0, 120)}, resolved_at = ${now}, updated_at = ${now}
      where id = ${id} and status = 'open' returning *`;
    return row<OperatorReviewRow>(x[0]);
  }
  // ops (migration 111): read-only, for /ready and the migrations script
  async listAppliedMigrations() {
    try {
      const r = await this.sql<{ name: string; checksum: string | null; applied_at: Date }[]>`select name, checksum, applied_at from engine_migrations order by name`;
      return r.map((x) => ({ name: x.name, checksum: x.checksum, applied_at: new Date(x.applied_at).toISOString() }));
    } catch (e) {
      if ((e as { code?: string }).code === "42P01") return null; // 111 not applied yet
      throw e;
    }
  }
  // bookings and verified receipts (migration 110); the database's triggers re-check every rule.
  async insertBooking(b: Omit<BookingRow, "created_at" | "updated_at">) {
    const r = await this.sql`insert into bookings ${this.sql(this.vals(b as never))} on conflict (approval_id) do nothing returning *`;
    return row<BookingRow>(r[0]);
  }
  async getBookingByApproval(approvalId: string) {
    return row<BookingRow>((await this.sql`select * from bookings where approval_id = ${approvalId}`)[0]);
  }
  async updateBooking(id: string, fromStatuses: BookingRow["status"][], patch: Partial<Pick<BookingRow, "status" | "request_message_id" | "reply_text" | "reply_message_id" | "reply_has_link" | "confirmed_at" | "stalled_at" | "cancel_reason">>) {
    try {
      const r = await this.sql`update bookings set ${this.sql(this.vals({ ...patch, updated_at: new Date().toISOString() } as never))} where id = ${id} and status = any(${fromStatuses}) returning *`;
      return row<BookingRow>(r[0]);
    } catch (e) {
      if ((e as { code?: string }).code === "P0001") return null; // the trigger refused (a final booking)
      throw e;
    }
  }
  async markHandoffStalled(id: string, at: string) {
    const r = await this.sql`update payment_handoffs set stalled_at = ${at}, updated_at = now() where id = ${id} and stalled_at is null and status in ('instructions_requested','instructions_received') returning *`;
    return handoffRow(r[0]);
  }
  async insertHandoffReceipt(r: Omit<HandoffReceiptRow, "created_at">) {
    const x = await this.sql`insert into handoff_receipts ${this.sql(this.vals(r as never))} on conflict (handoff_id) do nothing returning *`;
    return row<HandoffReceiptRow>(x[0]);
  }
  async getHandoffReceipt(handoffId: string) {
    return row<HandoffReceiptRow>((await this.sql`select * from handoff_receipts where handoff_id = ${handoffId}`)[0]);
  }
  // inbound review (migration 112)
  async insertQuarantineResolution(r: Omit<QuarantineResolutionRow, "resolved_at">) {
    const x = await this.sql`insert into quarantine_resolutions ${this.sql(this.vals(r as never))} on conflict (message_id) do nothing returning *`;
    return row<QuarantineResolutionRow>(x[0]);
  }
  async listQuarantineResolutions(q: { messageId?: string; jobId?: string; limit?: number }) {
    const s = this.sql;
    return rows<QuarantineResolutionRow>(await s`
      select * from quarantine_resolutions where true
        ${q.messageId !== undefined ? s`and message_id = ${q.messageId}` : s``}
        ${q.jobId !== undefined ? s`and job_id = ${q.jobId}` : s``}
      order by resolved_at desc, id desc limit ${q.limit ?? 200}`);
  }
  async listQuarantinedMessages(q: { jobId?: string; limit?: number }) {
    const s = this.sql;
    return rows<MessageRow>(await s`
      select * from messages where direction = 'in' and (kind = 'quarantine' or (kind = 'reply' and sender_trusted is not true))
        ${q.jobId !== undefined ? s`and job_id = ${q.jobId}` : s``}
      order by created_at desc, id desc limit ${q.limit ?? 100}`);
  }
  /** Pool slot usage for /ready: in use, queued, peaks, timeouts (counts only). */
  poolStats(): PoolStats {
    return this.gate.stats();
  }
  // reconciler high-water marks (migration 117)
  async getReconcileCursor(scope: string, channel: ReconcileChannel) {
    const r = await this.sql`select high_water from reconcile_cursors where scope = ${scope} and channel = ${channel}`;
    const v = r[0]?.high_water as Date | string | undefined;
    return v === undefined ? null : new Date(v).toISOString();
  }
  async advanceReconcileCursor(scope: string, channel: ReconcileChannel, at: string) {
    await this.sql`
      insert into reconcile_cursors (scope, channel, high_water) values (${scope}, ${channel}, ${at})
      on conflict (scope, channel) do update set high_water = greatest(reconcile_cursors.high_water, excluded.high_water), updated_at = now()`;
  }
  // operator actions (migration 119): append-only
  async appendOperatorAction(a: Omit<OperatorActionRow, "at">) {
    const x = await this.sql`insert into operator_actions (id, workspace_id, job_id, action, operator, reason, detail)
      values (${a.id}, ${a.workspace_id}, ${a.job_id}, ${a.action}, ${a.operator}, ${a.reason}, ${this.sql.json(a.detail as never)})
      returning id, workspace_id, job_id, action, operator, reason, detail, at`;
    return row<OperatorActionRow>(x[0])!;
  }
  async listOperatorActions(q: { workspaceId?: string; jobId?: string; actions?: OperatorAction[]; limit?: number }) {
    const s = this.sql;
    return rows<OperatorActionRow>(await s`
      select id, workspace_id, job_id, action, operator, reason, detail, at from operator_actions where true
        ${q.workspaceId !== undefined ? s`and workspace_id = ${q.workspaceId}` : s``}
        ${q.jobId !== undefined ? s`and job_id = ${q.jobId}` : s``}
        ${q.actions ? s`and action = any(${q.actions})` : s``}
      order by seq desc limit ${q.limit ?? 200}`);
  }
}
