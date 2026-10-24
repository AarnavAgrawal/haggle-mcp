-- Assertions for 116_engine_analytics.sql (owner: Yash, sprint 4 workstream E). Self-contained; counts
-- are compared as deltas because other assertion files leave their own rows behind.
\set ON_ERROR_STOP 1
create or replace function pg_temp.expect_fail(label text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    raise notice 'ok (rejected): % -- %', label, sqlerrm;
    return;
  end;
  raise exception 'NOT REJECTED: %', label;
end;
$$;

create temp table before_t as select * from public.analytics_traction;
create temp table before_x as select * from public.analytics_excluded;

insert into public.workspaces (id, name) values ('ws_an_real', 'Pilot customer'), ('ws_an_test', 'Internal demo');
insert into public.jobs (id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until, workspace_id) values
  ('job_an_real', 'ANRL', 'collecting', 'live', '{}', 50000, 'haggle+anr@x.test', 2, now() + interval '1 hour', 'ws_an_real'),
  ('job_an_mock', 'ANMK', 'collecting', 'mock', '{}', 50000, 'haggle+anm@x.test', 2, now() + interval '1 hour', 'ws_an_real'),
  ('job_an_test', 'ANTS', 'collecting', 'live', '{}', 50000, 'haggle+ant@x.test', 2, now() + interval '1 hour', 'ws_an_test');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status, contacted_at) values
  ('job_an_real', 'biz_a1a1a1a1a1a1a1a1', 'Harbor', 'harbor@an.test', 'agent', false, 'quoted', now()),
  ('job_an_real', 'biz_a2a2a2a2a2a2a2a2', 'Fleet Sim', 'sim@an.test', 'fleet', true, 'quoted', now()),
  ('job_an_mock', 'biz_a1a1a1a1a1a1a1a1', 'Harbor', 'harbor@an.test', 'agent', false, 'quoted', now()),
  ('job_an_test', 'biz_a1a1a1a1a1a1a1a1', 'Harbor', 'harbor@an.test', 'agent', false, 'quoted', now());
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status, sender_trusted, simulated) values
  ('man1', 'job_an_real', 'biz_a1a1a1a1a1a1a1a1', 'in', 'reply', 'em_an1', 'done', true, false),
  ('man2', 'job_an_real', 'biz_a1a1a1a1a1a1a1a1', 'in', 'reply', 'em_an2', 'done', false, false),
  ('man3', 'job_an_real', 'biz_a2a2a2a2a2a2a2a2', 'in', 'reply', 'em_an3', 'done', true, true),
  ('man4', 'job_an_mock', 'biz_a1a1a1a1a1a1a1a1', 'in', 'reply', 'em_an4', 'done', true, false),
  ('man5', 'job_an_test', 'biz_a1a1a1a1a1a1a1a1', 'in', 'reply', 'em_an5', 'done', true, false);
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source) values
  ('qan1', 'job_an_real', 'biz_a1a1a1a1a1a1a1a1', 'man1', 1, 'current', '{}', 115000, 34500, true, '[]', true, 'email body'),
  ('qan3', 'job_an_real', 'biz_a2a2a2a2a2a2a2a2', 'man3', 1, 'current', '{}', 99000, null, true, '[]', true, 'email body'),
  ('qan4', 'job_an_mock', 'biz_a1a1a1a1a1a1a1a1', 'man4', 1, 'current', '{}', 99000, null, true, '[]', true, 'email body'),
  ('qan5', 'job_an_test', 'biz_a1a1a1a1a1a1a1a1', 'man5', 1, 'current', '{}', 99000, null, true, '[]', true, 'email body');

-- The test workspace is marked; marks are append-only and validated.
insert into public.analytics_test_marks (target_kind, target_id, reason, marked_by) values ('workspace', 'ws_an_test', 'internal demo workspace', 'assertions');
select pg_temp.expect_fail('mark edited', $$update public.analytics_test_marks set marked = false where target_id = 'ws_an_test'$$);
select pg_temp.expect_fail('mark deleted', $$delete from public.analytics_test_marks where target_id = 'ws_an_test'$$);
select pg_temp.expect_fail('mark without a reason', $$insert into public.analytics_test_marks (target_kind, target_id, reason, marked_by) values ('job', 'job_an_real', '', 'assertions')$$);
select pg_temp.expect_fail('mark of an unknown kind', $$insert into public.analytics_test_marks (target_kind, target_id, reason, marked_by) values ('vendor', 'biz_a1a1a1a1a1a1a1a1', 'nope', 'assertions')$$);

do $$
declare t record; b record; x record; bx record;
begin
  select * into t from public.analytics_traction;
  select * into b from before_t;
  select * into x from public.analytics_excluded;
  select * into bx from before_x;
  if t.deals_created - b.deals_created <> 1 then raise exception 'deals_created delta %', t.deals_created - b.deals_created; end if;
  if t.vendors_contacted - b.vendors_contacted <> 1 then raise exception 'vendors_contacted delta %', t.vendors_contacted - b.vendors_contacted; end if;
  if t.real_replies - b.real_replies <> 1 then raise exception 'real_replies delta % (unverified or simulated replies counted)', t.real_replies - b.real_replies; end if;
  if t.quotes - b.quotes <> 1 then raise exception 'quotes delta %', t.quotes - b.quotes; end if;
  if x.mock_jobs - bx.mock_jobs <> 1 then raise exception 'mock_jobs delta %', x.mock_jobs - bx.mock_jobs; end if;
  if x.live_jobs_marked_test - bx.live_jobs_marked_test <> 1 then raise exception 'live_jobs_marked_test delta %', x.live_jobs_marked_test - bx.live_jobs_marked_test; end if;
  if x.simulated_vendors_in_real_jobs - bx.simulated_vendors_in_real_jobs <> 1 then raise exception 'simulated vendors delta %', x.simulated_vendors_in_real_jobs - bx.simulated_vendors_in_real_jobs; end if;
  if t.live_card_payments <> 0 then raise exception 'live card payments must be 0 (only Stripe test mode is allowed)'; end if;
end $$;

-- Marking the real job excludes it; a later unmark (newest row wins) brings it back.
insert into public.analytics_test_marks (target_kind, target_id, reason, marked_by) values ('job', 'job_an_real', 'smoke test', 'assertions');
do $$ begin if exists (select 1 from public.analytics_real_jobs where id = 'job_an_real') then raise exception 'marked job still counted'; end if; end $$;
insert into public.analytics_test_marks (target_kind, target_id, marked, reason, marked_by) values ('job', 'job_an_real', false, 'real after all', 'assertions');
do $$ begin if not exists (select 1 from public.analytics_real_jobs where id = 'job_an_real') then raise exception 'unmarked job not counted'; end if; end $$;

-- Nothing for anon/authenticated.
do $$ begin
  if has_table_privilege('anon', 'public.analytics_traction', 'select') or has_table_privilege('authenticated', 'public.analytics_test_marks', 'select') then
    raise exception 'analytics objects are readable by client roles';
  end if;
end $$;

delete from public.jobs where id in ('job_an_real', 'job_an_mock', 'job_an_test');
\echo 'all analytics assertions passed'
