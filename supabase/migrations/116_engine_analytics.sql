-- 116_engine_analytics (owner: Yash, sprint 4 workstream E). Pilot traction and abandonment, read-only.
--   * analytics_test_marks: an operator marks a whole WORKSPACE or a single JOB as test (an internal
--     dry run, a smoke test against live providers, a demo for a prospect). Marks are append-only; an
--     unmark is a new row with marked = false (the latest row per target wins).
--   * analytics_real_jobs: the jobs that can count as traction: live mode (never mock), in a workspace
--     not marked test, and not itself marked test.
--   * analytics_traction: one row of verified outcomes over those jobs, counting only non-simulated
--     businesses, verified senders, human (non-simulated) approvals, bookings the business confirmed,
--     payments the customer reported, receipts the business confirmed, and charges that moved real
--     money (never simulated, never Stripe test mode, never the legacy x402 rail).
-- Additive only: no existing table, constraint or trigger is changed. Views use security_invoker, so
-- the engine tables' RLS still applies to whoever queries them.

create table public.analytics_test_marks (
  id          bigint generated always as identity primary key,
  target_kind text not null check (target_kind in ('workspace','job')),
  target_id   text not null check (length(target_id) between 3 and 80),
  marked      boolean not null default true,
  reason      text not null check (length(reason) between 3 and 300),
  marked_by   text not null check (length(marked_by) between 2 and 80),
  marked_at   timestamptz not null default now()
);
create index analytics_test_marks_target_idx on public.analytics_test_marks(target_kind, target_id, marked_at desc);

create or replace function public.haggle_test_marks_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'analytics_test_marks is append-only: add a row with marked = false to unmark';
end;
$$;
create trigger analytics_test_marks_append_only before update or delete on public.analytics_test_marks
  for each row execute function public.haggle_test_marks_append_only();

-- The current mark per target (latest row wins).
create view public.analytics_test_targets with (security_invoker = true) as
  select distinct on (target_kind, target_id) target_kind, target_id, marked, reason, marked_by, marked_at
  from public.analytics_test_marks
  order by target_kind, target_id, marked_at desc, id desc;

create view public.analytics_real_jobs with (security_invoker = true) as
  select j.*
  from public.jobs j
  where j.mode = 'live'
    and not exists (select 1 from public.analytics_test_targets t where t.target_kind = 'workspace' and t.target_id = j.workspace_id and t.marked)
    and not exists (select 1 from public.analytics_test_targets t where t.target_kind = 'job' and t.target_id = j.id and t.marked);

create view public.analytics_real_vendors with (security_invoker = true) as
  select jb.*
  from public.job_businesses jb
  join public.analytics_real_jobs j on j.id = jb.job_id
  where not jb.simulated;

create view public.analytics_traction with (security_invoker = true) as
  select
    (select count(*) from public.analytics_real_jobs) as deals_created,
    (select count(*) from public.analytics_real_jobs j where exists (select 1 from public.analytics_real_vendors v where v.job_id = j.id and v.contacted_at is not null)) as deals_with_real_vendor_contacted,
    (select count(*) from public.analytics_real_vendors v where v.contacted_at is not null) as vendors_contacted,
    (select count(distinct v.business_id) from public.analytics_real_vendors v where v.contacted_at is not null) as distinct_vendors_contacted,
    (select count(*) from public.messages m join public.analytics_real_vendors v on v.job_id = m.job_id and v.business_id = m.business_id
       where m.direction = 'in' and m.kind = 'reply' and m.sender_trusted is true and not m.simulated) as real_replies,
    (select count(distinct (m.job_id, m.business_id)) from public.messages m join public.analytics_real_vendors v on v.job_id = m.job_id and v.business_id = m.business_id
       where m.direction = 'in' and m.kind = 'reply' and m.sender_trusted is true and not m.simulated) as vendors_replied,
    (select count(*) from public.quotes q join public.analytics_real_vendors v on v.job_id = q.job_id and v.business_id = q.business_id
       where q.sender_trusted and q.total_cents is not null) as quotes,
    (select count(distinct q.job_id) from public.quotes q join public.analytics_real_vendors v on v.job_id = q.job_id and v.business_id = q.business_id
       where q.sender_trusted and q.total_cents is not null) as deals_with_quote,
    (select count(*) from public.approvals a join public.analytics_real_vendors v on v.job_id = a.job_id and v.business_id = a.business_id
       where a.status in ('approved','used') and a.channel <> 'simulated') as human_approvals,
    (select count(*) from public.bookings b join public.analytics_real_vendors v on v.job_id = b.job_id and v.business_id = b.business_id
       where b.status = 'confirmed') as bookings_vendor_confirmed,
    (select count(*) from public.bookings b join public.analytics_real_vendors v on v.job_id = b.job_id and v.business_id = b.business_id
       where b.status = 'not_in_writing') as bookings_human_confirmed_only,
    (select count(*) from public.payment_handoffs h join public.analytics_real_vendors v on v.job_id = h.job_id and v.business_id = h.business_id
       where h.status = 'human_confirmed') as customer_reported_payments,
    (select coalesce(sum(h.amount_cents), 0) from public.payment_handoffs h join public.analytics_real_vendors v on v.job_id = h.job_id and v.business_id = h.business_id
       where h.status = 'human_confirmed') as customer_reported_cents,
    (select count(*) from public.handoff_receipts r join public.payment_handoffs h on h.id = r.handoff_id
       join public.analytics_real_vendors v on v.job_id = h.job_id and v.business_id = h.business_id) as vendor_verified_receipts,
    (select coalesce(sum(h.amount_cents), 0) from public.handoff_receipts r join public.payment_handoffs h on h.id = r.handoff_id
       join public.analytics_real_vendors v on v.job_id = h.job_id and v.business_id = h.business_id) as vendor_verified_cents,
    (select count(*) from public.payments p join public.analytics_real_vendors v on v.job_id = p.job_id and v.business_id = p.business_id
       where p.status = 'settled' and not p.simulated and p.rail = 'stripe' and p.network = 'stripe') as live_card_payments;

-- What was left out, so a report can say why its numbers are small.
create view public.analytics_excluded with (security_invoker = true) as
  select
    (select count(*) from public.jobs where mode = 'mock') as mock_jobs,
    (select count(*) from public.jobs j where j.mode = 'live' and not exists (select 1 from public.analytics_real_jobs r where r.id = j.id)) as live_jobs_marked_test,
    (select count(*) from public.job_businesses jb join public.analytics_real_jobs j on j.id = jb.job_id where jb.simulated) as simulated_vendors_in_real_jobs,
    (select count(*) from public.payments p where p.simulated or p.rail <> 'stripe' or p.network <> 'stripe') as simulated_or_test_payments,
    (select count(*) from public.analytics_test_targets where target_kind = 'workspace' and marked) as test_workspaces,
    (select count(*) from public.analytics_test_targets where target_kind = 'job' and marked) as test_jobs;

do $$
declare t text;
begin
  execute 'alter table public.analytics_test_marks enable row level security';
  execute 'alter table public.analytics_test_marks force row level security';
  foreach t in array array['analytics_test_marks','analytics_test_targets','analytics_real_jobs','analytics_real_vendors','analytics_traction','analytics_excluded'] loop
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;
