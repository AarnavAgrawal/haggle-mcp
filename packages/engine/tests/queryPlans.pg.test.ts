// Query plans for the job board, polling and matching paths on a seeded Postgres (sprint 4,
// workstream F). Its own throwaway database on the test server: every migration but 117 is applied,
// the data seeded, the hot queries EXPLAIN ANALYZEd ("before"); then 117 is applied and they run again
// ("after"). Default size is small enough for the suite; HAGGLE_QUERY_BENCH=1 seeds 10k jobs and
// 200k events and prints the timings recorded in the sprint report. Postgres only.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
const BIG = process.env.HAGGLE_QUERY_BENCH === "1";
const JOBS = BIG ? 10_000 : 2_000;
const EVENTS_PER_JOB = 20; // 200k events at 10k jobs
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");

/** The repository's SQL (store/postgres.ts), with sample parameters. `old` is findBusinessCandidates before 117's rewrite. */
const QUERIES: Record<string, { sql: string; params: (s: Sample) => unknown[] }> = {
  listOpenJobs: { sql: "select * from jobs where state not in ('paid','confirmed','cancelled','failed') order by created_at", params: () => [] },
  listRecentJobs: { sql: "select * from jobs order by updated_at desc, created_at desc limit 50", params: () => [] },
  listEvents_all: { sql: "select * from job_events where job_id = $1 and seq > $2 order by seq", params: (s) => [s.jobId, 0] },
  listEvents_cursor: { sql: "select * from job_events where job_id = $1 and seq > $2 order by seq", params: (s) => [s.jobId, 15] },
  getPendingMessages: { sql: "select * from messages where job_id = $1 and parse_status = 'pending' order by created_at, id", params: (s) => [s.jobId] },
  listMessages: { sql: "select * from messages where job_id = $1 order by created_at, id", params: (s) => [s.jobId] },
  listOutbox_job: { sql: "select * from outbox where true and job_id = $1 order by created_at limit 500", params: (s) => [s.jobId] },
  listTextRoutes: { sql: "select * from text_routes where line = $1 and remote = $2 order by last_out_at desc", params: (s) => ["default", s.phone] },
  findBusinessCandidates_old: {
    sql: `select b.*, j.short_code from job_businesses b join jobs j on j.id = b.job_id
      where j.short_code = any($1) or ($2::text is not null and b.thread_id = $2)
         or lower(btrim(b.rfq_message_id, '<>')) = any($3)
         or exists (select 1 from messages m where m.direction = 'out' and m.job_id = b.job_id and m.business_id = b.business_id and lower(btrim(m.rfc_message_id, '<>')) = any($3))`,
    params: (s) => [[], null, [s.rfq]],
  },
  findBusinessCandidates_new: {
    sql: `select b.*, j.short_code from job_businesses b join jobs j on j.id = b.job_id where j.short_code = any($1)
      union select b.*, (select short_code from jobs where id = b.job_id) from job_businesses b where b.thread_id = $2
      union select b.*, (select short_code from jobs where id = b.job_id) from job_businesses b where lower(btrim(b.rfq_message_id, '<>')) = any($3)
      union select b.*, (select short_code from jobs where id = b.job_id) from messages m join job_businesses b on b.job_id = m.job_id and b.business_id = m.business_id
        where m.direction = 'out' and lower(btrim(m.rfc_message_id, '<>')) = any($3)`,
    params: (s) => [[], null, [s.rfq]],
  },
  opsQuarantined: { sql: "select count(*) from messages where job_id = any($1) and quarantine_reason is not null", params: (s) => [s.openJobIds] },
  listPendingApprovalsByChannel: { sql: "select * from approvals where status = 'pending' and channel = $1 order by created_at desc", params: () => ["imessage"] },
};
type Sample = { jobId: string; phone: string; rfq: string; openJobIds: string[] };

async function measure(sql: postgres.Sql, s: Sample) {
  const out: Record<string, { ms: number; plan: string; seqScans: string[] }> = {};
  for (const [name, q] of Object.entries(QUERIES)) {
    const params = q.params(s) as never[];
    const runs: number[] = [];
    let plan: { Plan: Record<string, unknown>; "Execution Time": number } | null = null;
    for (let i = 0; i < 5; i++) {
      const [r] = await sql.unsafe(`explain (analyze, format json) ${q.sql}`, params);
      plan = (r!["QUERY PLAN"] as typeof plan[])[0]!;
      runs.push(plan!["Execution Time"]);
    }
    const nodes: string[] = [];
    const seq: string[] = [];
    const walk = (n: Record<string, unknown>) => {
      nodes.push(`${n["Node Type"]}${n["Index Name"] ? `(${n["Index Name"]})` : n["Relation Name"] ? `(${n["Relation Name"]})` : ""}`);
      if (n["Node Type"] === "Seq Scan") seq.push(String(n["Relation Name"]));
      for (const c of (n.Plans as Record<string, unknown>[] | undefined) ?? []) walk(c);
    };
    walk(plan!.Plan);
    out[name] = { ms: runs.sort((a, b) => a - b)[2]!, plan: nodes.filter((x) => /Scan/.test(x)).join(", "), seqScans: seq };
  }
  return out;
}

async function seed(sql: postgres.Sql) {
  const states = ["collecting", "negotiating", "awaiting_approval", "paying", "contacting"];
  await sql.unsafe(`
    insert into jobs (id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until, created_at, updated_at)
    select 'job_b' || lpad(i::text, 6, '0'), 'B' || lpad(i::text, 6, '0'),
      case when i % 10 = 0 then (array['${states.join("','")}'])[1 + (i / 10) % 5] else (array['paid','cancelled','failed','confirmed'])[1 + i % 4] end,
      'live', '{}'::jsonb, 100000, 'haggle+' || i || '@inkboxmail.test', 2, now() - (i || ' minutes')::interval,
      now() - (i || ' minutes')::interval, now() - (i || ' minutes')::interval
    from generate_series(1, ${JOBS}) i`);
  await sql.unsafe(`
    insert into job_businesses (job_id, business_id, name, email, source, simulated, status, channel, thread_id, rfq_message_id)
    select 'job_b' || lpad(i::text, 6, '0'), 'biz_' || lpad(to_hex(i * 10 + k), 16, '0'), 'Vendor ' || k, 'v' || k || '-' || i || '@vendor.example', 'agent', false, 'contacted', 'email',
      'th_' || i || '_' || k, '<rfq-' || i || '-' || k || '@haggle.test>'
    from generate_series(1, ${JOBS}) i, generate_series(1, 5) k`);
  await sql.unsafe(`
    insert into messages (id, job_id, business_id, direction, kind, idempotency_key, provider_email_id, rfc_message_id, parse_status, quarantine_reason, channel, created_at)
    select 'msg_b' || i || '_' || k || '_' || d, 'job_b' || lpad(i::text, 6, '0'), 'biz_' || lpad(to_hex(i * 10 + k), 16, '0'),
      case when d = 1 then 'out' else 'in' end, case when d = 1 then 'rfq' else 'reply' end,
      case when d = 1 then 'rfq:job_b' || i || ':' || k else null end, 'pv_' || i || '_' || k || '_' || d,
      '<' || case when d = 1 then 'out' else 'in' end || '-' || i || '-' || k || '@x.test>',
      case when d = 2 and k = 1 and i % 50 = 0 then 'pending' else 'done' end,
      case when d = 2 and k = 2 and i % 40 = 0 then 'sender_not_verified' else null end, 'email', now() - (i || ' minutes')::interval
    from generate_series(1, ${JOBS}) i, generate_series(1, 4) k, generate_series(1, 2) d`);
  await sql.unsafe(`insert into job_events (job_id, seq, type, data) select 'job_b' || lpad(i::text, 6, '0'), s, 'reply', '{"summary":"x"}'::jsonb from generate_series(1, ${JOBS}) i, generate_series(1, ${EVENTS_PER_JOB}) s`);
  await sql.unsafe(`insert into outbox (key, job_id, kind, status) select 'rfq:job_b' || i || ':' || k, 'job_b' || lpad(i::text, 6, '0'), 'email', 'sent' from generate_series(1, ${JOBS}) i, generate_series(1, 5) k`);
  await sql.unsafe(`insert into text_routes (line, remote, workspace_id, job_id, purpose, last_out_at) select 'default', '+1415555' || lpad((i % 5000)::text, 4, '0'), 'ws_default', 'job_b' || lpad(i::text, 6, '0'), 'human', now() from generate_series(1, ${JOBS}) i`);
  await sql.unsafe("analyze");
}

describe.skipIf(!PG_URL)("query plans on a seeded database (migration 117)", { timeout: 600_000 }, () => {
  it("before vs after 117: open jobs, inbound matching and the ops report use indexes; timings logged", async () => {
    const admin = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    const name = `haggle_bench_${Math.random().toString(36).slice(2, 8)}`;
    await admin.unsafe(`create database ${name}`);
    const url = new URL(PG_URL!);
    url.pathname = `/${name}`;
    const db = postgres(url.href, { max: 1, onnotice: () => {} });
    try {
      const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
      for (const f of files.filter((x) => !x.startsWith("117_"))) await db.unsafe(readFileSync(join(MIGRATIONS, f), "utf8"));
      const t0 = Date.now();
      await seed(db);
      const seededMs = Date.now() - t0;
      const sample: Sample = { jobId: "job_b000500", phone: "+14155550500", rfq: "rfq-777-3@haggle.test", openJobIds: (await db`select id from jobs where state not in ('paid','confirmed','cancelled','failed')`).map((r) => r.id as string) };
      const before = await measure(db, sample);
      await db.unsafe(readFileSync(join(MIGRATIONS, "117_engine_ops.sql"), "utf8"));
      await db.unsafe("analyze");
      const after = await measure(db, sample);
      const rows = Object.keys(QUERIES).map((k) => `${k.padEnd(32)} ${before[k]!.ms.toFixed(3).padStart(9)} ms -> ${after[k]!.ms.toFixed(3).padStart(9)} ms   ${after[k]!.plan}`);
      console.log(`[query-bench] ${JOBS} jobs, ${JOBS * EVENTS_PER_JOB} events, ${JOBS * 5} businesses, ${JOBS * 8} messages (seeded in ${seededMs} ms); median of 5 EXPLAIN ANALYZE runs\n${rows.join("\n")}`);
      // After 117 the per-tick and per-inbound paths no longer scan whole tables.
      expect(after.listOpenJobs!.seqScans).toEqual([]);
      expect(after.findBusinessCandidates_new!.seqScans).toEqual([]);
      expect(before.findBusinessCandidates_old!.seqScans.length).toBeGreaterThan(0);
      expect(after.opsQuarantined!.seqScans).toEqual([]);
      for (const k of ["listEvents_all", "listEvents_cursor", "getPendingMessages", "listMessages", "listOutbox_job", "listTextRoutes"]) expect(after[k]!.seqScans, k).toEqual([]);
      // The rewrite finds exactly what the old query found.
      const [o, n] = await Promise.all([db.unsafe(QUERIES.findBusinessCandidates_old!.sql, QUERIES.findBusinessCandidates_old!.params(sample) as never[]), db.unsafe(QUERIES.findBusinessCandidates_new!.sql, QUERIES.findBusinessCandidates_new!.params(sample) as never[])]);
      expect(n.map((r) => `${r.job_id}/${r.business_id}`).sort()).toEqual(o.map((r) => `${r.job_id}/${r.business_id}`).sort());
      expect(n.length).toBe(1);
      const t = await db.unsafe(QUERIES.findBusinessCandidates_new!.sql, [[], "th_12_2", ["none"]] as never[]);
      expect(t.map((r) => r.business_id)).toHaveLength(1);
    } finally {
      await db.end({ timeout: 5 });
      await admin.unsafe(`drop database if exists ${name} with (force)`);
      await admin.end({ timeout: 5 });
    }
  });
});
