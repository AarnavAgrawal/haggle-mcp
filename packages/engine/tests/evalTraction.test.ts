// Sprint 4 (E): pilot instrumentation. The abandonment funnel derived from job_events (real engine
// jobs and hand-built event logs), and traction on Postgres (migration 116) over mixed rows: only
// live jobs outside test workspaces/jobs, non-simulated businesses, verified senders, human approvals,
// vendor-confirmed bookings, customer-reported payments and vendor-verified receipts count.
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { buildFunnel, jobMilestone, loadFunnel, loadTraction, markTest, STOP_REASON, type FunnelEvent } from "../src/ops/traction.ts";
import { CORPUS_REQUEST } from "../eval/corpus.ts";
import { makeEnv, trusted } from "../eval/harness.ts";
import { heuristicExtractor } from "../src/live/adapters.ts";

const ev = (type: string, data: Record<string, unknown> = {}): FunnelEvent => ({ type, data });
const created = [ev("state", { from: null, to: "created" })];
const contacted = [...created, ev("state", { from: "contacting", to: "collecting" })];
const quoted = [...contacted, ev("quote", { total_usd: 1150 })];
const asked = [...quoted, ev("approval_requested", { approval_id: "a1" })];
const approved = [...asked, ev("state", { from: "awaiting_approval", to: "paying" }), ev("booking", { status: "awaiting_vendor_confirmation" })];
const booked = [...approved, ev("booking", { status: "confirmed" })];
const reported = [...booked, ev("payment", { status: "human_reported_paid" })];
const done = [...reported, ev("payment", { status: "settled_verified" })];

describe("abandonment funnel (from job_events)", () => {
  it("places each job at the furthest milestone it reached and names where it stopped", () => {
    const f = buildFunnel([
      { id: "j0", state: "created", events: created },
      { id: "j1", state: "collecting", events: contacted },
      { id: "j2", state: "collecting", events: [...contacted, ev("quote", { total_usd: null })] },
      { id: "j3", state: "failed", events: [...quoted, ev("state", { from: "collecting", to: "failed" })] },
      { id: "j4", state: "awaiting_approval", events: asked },
      { id: "j5", state: "paying", events: approved },
      { id: "j6", state: "paying", events: booked },
      { id: "j7", state: "paying", events: reported },
      { id: "j8", state: "paid", events: done },
      { id: "j9", state: "cancelled", events: [...asked, ev("state", { from: "awaiting_approval", to: "cancelled" })] },
      { id: "j10", state: "confirmed", events: [...asked, ev("state", { from: "awaiting_approval", to: "confirmed" })] },
    ]);
    expect(f.rows.map((r) => r.milestone)).toEqual(["created", "contacted", "replied", "quoted", "approval_requested", "approved", "booked", "payment_reported", "completed", "approval_requested", "completed"]);
    expect(f.reached).toMatchObject({ created: 11, contacted: 10, replied: 9, quoted: 8, approval_requested: 7, approved: 5, booked: 4, payment_reported: 3, completed: 2 }); // completed counts as reaching every earlier milestone (j10 is confirm-only)
    const stop = Object.fromEntries(f.stopped.map((s) => [s.reason, s]));
    expect(stop[STOP_REASON.contacted]).toEqual({ reason: STOP_REASON.contacted, open: 1, ended: 0 });
    expect(stop[STOP_REASON.quoted]).toMatchObject({ open: 0, ended: 1 }); // failed: no compliant quote approved
    expect(stop[STOP_REASON.approval_requested]).toMatchObject({ open: 1, ended: 1 }); // one pending, one cancelled
    expect(stop[STOP_REASON.approved]!.reason).toMatch(/booking unconfirmed/);
    expect(stop[STOP_REASON.booked]!.reason).toMatch(/handoff stalled/);
    expect(f.rows.find((r) => r.job_id === "j8")).toMatchObject({ stopped_at: null, ended: "done" });
  });

  it("reads real engine event logs: contacted with no reply, then quoted after a reply", async () => {
    const env = await makeEnv({ extractor: heuristicExtractor });
    try {
      const { request, budget_usd } = CORPUS_REQUEST;
      const deal = await env.engine.deal({ request, budget_usd, businesses: [{ name: "Harbor", email: "quotes@harbor.corpus.example" }] });
      const events = async () => (await env.repo.listEvents(deal.job_id)).map((e) => ({ type: e.type, data: e.data }));
      expect(jobMilestone({ id: deal.job_id, state: "collecting", events: await events() })).toBe("contacted");
      const b = (await env.repo.getBusinesses(deal.job_id))[0]!;
      env.clock.advance(10 * 60_000);
      await env.ingest({ from: "quotes@harbor.corpus.example", bodyText: "Total: $1,150 delivered, tax included. 12 vegetarian.", inReplyTo: [b.rfq_message_id!], references: [b.rfq_message_id!], threadId: "th_h" }, trusted);
      await env.engine.advanceJob(deal.job_id);
      expect(jobMilestone({ id: deal.job_id, state: "collecting", events: await events() })).toBe("quoted");
    } finally {
      env.restore();
    }
  });
});

const PG_URL = process.env.HAGGLE_TEST_DATABASE_URL;
describe.skipIf(!PG_URL)("traction on Postgres (migration 116): mixed real, simulated and test rows", { timeout: 60_000 }, () => {
  it("counts only verified outcomes of real jobs, and test marks move jobs in and out", async () => {
    const sql = postgres(PG_URL!, { max: 1, onnotice: () => {} });
    const u = Math.random().toString(36).slice(2, 8);
    const U = u.toUpperCase().replace(/[^A-Z0-9]/g, "X");
    try {
      const before = await loadTraction(sql);
      const wsReal = `ws_tr_real_${u}`;
      const wsTest = `ws_tr_test_${u}`;
      await sql`insert into public.workspaces (id, name) values (${wsReal}, 'Real pilot'), (${wsTest}, 'Internal demo')`;
      const job = async (id: string, code: string, ws: string, mode: "live" | "mock", state = "paying") => {
        await sql`insert into public.jobs (id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until, workspace_id)
          values (${id}, ${code}, ${state}, ${mode}, '{}', 50000, ${`haggle+${id}@x.test`}, 2, now() + interval '1 hour', ${ws})`;
      };
      const vendor = async (jobId: string, biz: string, simulated: boolean) => {
        await sql`insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status, contacted_at)
          values (${jobId}, ${biz}, ${biz}, ${`${biz}@x.test`}, 'agent', ${simulated}, 'quoted', now())`;
      };
      let n = 0;
      const reply = async (jobId: string, biz: string, trusted: boolean, simulated = false) => {
        const id = `m_${u}_${++n}`;
        await sql`insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status, sender_trusted, simulated)
          values (${id}, ${jobId}, ${biz}, 'in', 'reply', ${`em_${id}`}, 'done', ${trusted}, ${simulated})`;
        return id;
      };
      const quote = async (jobId: string, biz: string, msg: string, trustedSender = true) => {
        const id = `q_${u}_${++n}`;
        await sql`insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
          values (${id}, ${jobId}, ${biz}, ${msg}, 1, 'current', '{}', 115000, 34500, true, '[]', ${trustedSender}, 'email body')`;
        return id;
      };
      const event = async (jobId: string, type: string, data: Record<string, unknown>) => { await sql`select public.haggle_append_event(${jobId}, ${type}, ${sql.json(data as never)})`; };

      // 1. A real live deal, all the way to a vendor-verified receipt, plus a simulated vendor and an unverified reply.
      const real = `job_trreal${u}`;
      const realBiz = `biz_${"1".repeat(10)}${u.padEnd(6, "0").replace(/[^0-9a-f]/g, "a")}`;
      const simBiz = `biz_${"2".repeat(10)}${u.padEnd(6, "0").replace(/[^0-9a-f]/g, "a")}`;
      await job(real, `R${U}`.slice(0, 8), wsReal, "live");
      await vendor(real, realBiz, false);
      await vendor(real, simBiz, true);
      const m1 = await reply(real, realBiz, true);
      await reply(real, realBiz, false); // unverified sender: never a real reply
      const ms = await reply(real, simBiz, true, true);
      const q1 = await quote(real, realBiz, m1);
      await quote(real, simBiz, ms);
      const ap = `ap_${u}`;
      await sql`insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action)
        values (${ap}, ${real}, ${q1}, ${realBiz}, 115000, 34500, 50000, 'imessage', 'pending', '4321', now() + interval '30 minutes', 'pay')`;
      await sql`update public.approvals set status = 'approved', decided_at = now() where id = ${ap}`;
      await sql`insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status) values (${`bk_${u}`}, ${real}, ${ap}, ${q1}, ${realBiz}, 115000, 34500, 'awaiting_vendor_confirmation')`;
      await sql`update public.bookings set status = 'confirmed', confirmed_at = now() where id = ${`bk_${u}`}`;
      await sql`insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values (${`ho_${u}`}, ${real}, ${ap}, ${realBiz}, 34500, 'instructions_requested')`;
      await sql`update public.payment_handoffs set status = 'human_confirmed', confirmed_by = '+14155550101', confirmed_at = now() where id = ${`ho_${u}`}`;
      await sql`insert into public.handoff_receipts (id, handoff_id, job_id, message_id, evidence) values (${`rc_${u}`}, ${`ho_${u}`}, ${real}, ${m1}, 'Got the deposit, thanks!')`;
      for (const [t, d] of [["state", { from: null, to: "created" }], ["state", { from: "contacting", to: "collecting" }], ["quote", { total_usd: 1150 }], ["approval_requested", { approval_id: ap }], ["state", { from: "awaiting_approval", to: "paying" }], ["booking", { status: "confirmed" }], ["payment", { status: "human_reported_paid" }], ["payment", { status: "settled_verified" }]] as const) await event(real, t, d);

      // 2. A mock job, a live job in a test workspace, and a live job marked test: none count.
      const mock = `job_trmock${u}`;
      await job(mock, `M${U}`.slice(0, 8), wsReal, "mock");
      await vendor(mock, realBiz, false);
      await quote(mock, realBiz, await reply(mock, realBiz, true));
      const inTestWs = `job_trtws${u}`;
      await job(inTestWs, `T${U}`.slice(0, 8), wsTest, "live", "collecting");
      await vendor(inTestWs, realBiz, false);
      await reply(inTestWs, realBiz, true);
      const marked = `job_trmark${u}`;
      await job(marked, `K${U}`.slice(0, 8), wsReal, "live", "collecting");
      await vendor(marked, realBiz, false);
      await event(marked, "state", { from: "contacting", to: "collecting" });
      await markTest(sql, { kind: "workspace", id: wsTest }, true, "internal demo workspace", "eval test");
      await markTest(sql, { kind: "job", id: marked }, true, "smoke test", "eval test");
      await expect(markTest(sql, { kind: "job", id: "job_doesnotexist" }, true, "typo", "eval test")).rejects.toThrow(/no job/);

      const after = await loadTraction(sql);
      const d = Object.fromEntries(Object.entries(after.traction).map(([k, v]) => [k, v - before.traction[k as keyof typeof before.traction]]));
      expect(d).toEqual({
        deals_created: 1, deals_with_real_vendor_contacted: 1, vendors_contacted: 1, distinct_vendors_contacted: expect.any(Number), real_replies: 1, vendors_replied: 1,
        quotes: 1, deals_with_quote: 1, human_approvals: 1, bookings_vendor_confirmed: 1, bookings_human_confirmed_only: 0,
        customer_reported_payments: 1, customer_reported_cents: 34500, vendor_verified_receipts: 1, vendor_verified_cents: 34500, live_card_payments: 0,
      });
      expect(after.excluded.mock_jobs - before.excluded.mock_jobs).toBe(1);
      expect(after.excluded.live_jobs_marked_test - before.excluded.live_jobs_marked_test).toBe(2);
      expect(after.excluded.simulated_vendors_in_real_jobs - before.excluded.simulated_vendors_in_real_jobs).toBe(1);

      // The funnel over real jobs sees the completed deal and not the test or mock ones.
      const f = await loadFunnel(sql);
      expect(f.rows.find((r) => r.job_id === real)).toMatchObject({ milestone: "completed", stopped_at: null });
      expect(f.rows.some((r) => [mock, inTestWs, marked].includes(r.job_id))).toBe(false);

      // Unmarking brings the job back (append-only: a new row wins); marks can't be edited or deleted.
      await markTest(sql, { kind: "job", id: marked }, false, "it was a real pilot deal", "eval test");
      expect((await loadTraction(sql)).traction.deals_created - before.traction.deals_created).toBe(2);
      expect((await loadFunnel(sql)).rows.find((r) => r.job_id === marked)).toMatchObject({ milestone: "contacted", stopped_at: STOP_REASON.contacted });
      await expect(sql`update public.analytics_test_marks set marked = true where target_id = ${marked}`).rejects.toThrow(/append-only/);
      await expect(sql`delete from public.analytics_test_marks where target_id = ${marked}`).rejects.toThrow(/append-only/);
      await markTest(sql, { kind: "job", id: marked }, true, "smoke test after all", "eval test");
      for (const j of [real, mock, inTestWs, marked]) await sql`delete from public.jobs where id = ${j}`;
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
