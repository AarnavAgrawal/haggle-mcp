-- Assertions for 108_engine_tenancy.sql (owner: Yash). Self-contained; uses its own workspaces and jobs.
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

insert into public.workspaces (id, name, timezone) values ('ws_ten_a', 'Tenant A', 'America/Los_Angeles'), ('ws_ten_b', 'Tenant B', 'America/Los_Angeles');
insert into public.jobs (id, workspace_id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until)
  values ('job_ten_a', 'ws_ten_a', 'TENA', 'collecting', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour'),
         ('job_ten_b', 'ws_ten_b', 'TENB', 'collecting', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');

-- Text routes: tied to their job's workspace; a business route names its business; one row per job and purpose.
insert into public.text_routes (line, remote, workspace_id, job_id, purpose, question_id, last_out_at) values ('default', '+14155550101', 'ws_ten_a', 'job_ten_a', 'human', 'q1', now());
insert into public.text_routes (line, remote, workspace_id, job_id, purpose, business_id, last_out_at) values ('default', '+14155550177', 'ws_ten_b', 'job_ten_b', 'business', 'biz_1', now());
select pg_temp.expect_fail('route pointing at another workspace''s job', $$insert into public.text_routes (line, remote, workspace_id, job_id, purpose, last_out_at) values ('default','+14155550102','ws_ten_b','job_ten_a','human',now())$$);
select pg_temp.expect_fail('route moved to another workspace', $$update public.text_routes set workspace_id = 'ws_ten_b' where job_id = 'job_ten_a'$$);
select pg_temp.expect_fail('business route without its business', $$insert into public.text_routes (line, remote, workspace_id, job_id, purpose, last_out_at) values ('default','+14155550178','ws_ten_a','job_ten_a','business',now())$$);
select pg_temp.expect_fail('business route carrying a human question', $$insert into public.text_routes (line, remote, workspace_id, job_id, purpose, business_id, question_id, last_out_at) values ('default','+14155550179','ws_ten_a','job_ten_a','business','biz_2','q9',now())$$);
select pg_temp.expect_fail('second route for the same job and purpose', $$insert into public.text_routes (line, remote, workspace_id, job_id, purpose, last_out_at) values ('default','+14155550101','ws_ten_a','job_ten_a','human',now())$$);

-- Held texts: same workspace rule; one per key.
insert into public.held_texts (line, remote, key, workspace_id, job_id, text, approval_id) values ('default', '+14155550101', 'notify:job_ten_a:x', 'ws_ten_a', 'job_ten_a', 'Haggle: approve?', 'ap1');
select pg_temp.expect_fail('held text for another workspace''s job', $$insert into public.held_texts (line, remote, key, workspace_id, job_id, text) values ('default','+14155550101','k2','ws_ten_b','job_ten_a','x')$$);
select pg_temp.expect_fail('held text held twice', $$insert into public.held_texts (line, remote, key, workspace_id, job_id, text) values ('default','+14155550101','notify:job_ten_a:x','ws_ten_a','job_ten_a','x')$$);

-- Suppression removals are append-only.
insert into public.suppression_removals (contact, reason, suppressed_at, removed_by, why) values ('x@y.test', 'bounce', now(), 'operator', 'mailbox was full, not a hard bounce');
select pg_temp.expect_fail('suppression removal edited', $$update public.suppression_removals set why = 'nothing' where contact = 'x@y.test'$$);
select pg_temp.expect_fail('suppression removal deleted', $$delete from public.suppression_removals where contact = 'x@y.test'$$);
select pg_temp.expect_fail('suppression removal without a reason', $$insert into public.suppression_removals (contact, reason, suppressed_at, removed_by, why) values ('x@y.test','bounce',now(),'operator','')$$);

-- Workspace vendor channel matches the contact.
insert into public.workspace_vendors (workspace_id, contact, name, consent, added_by, channel) values ('ws_ten_a', '+14155550188', 'Text Shop', 'owner agreed', 'operator', 'imessage');
select pg_temp.expect_fail('email channel on a phone contact', $$insert into public.workspace_vendors (workspace_id, contact, name, consent, added_by, channel) values ('ws_ten_a','+14155550189','X','owner agreed','operator','email')$$);
select pg_temp.expect_fail('unknown vendor channel', $$insert into public.workspace_vendors (workspace_id, contact, name, consent, added_by, channel) values ('ws_ten_a','a@b.test','X','owner agreed','operator','fax')$$);

-- RLS on, nothing granted to the client roles.
do $$
declare t text;
begin
  foreach t in array array['text_routes','held_texts','suppression_removals'] loop
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = format('public.%I', t)::regclass) then raise exception 'RLS off on %', t; end if;
    if has_table_privilege('anon', format('public.%I', t), 'select') or has_table_privilege('authenticated', format('public.%I', t), 'select') then raise exception 'client role can read %', t; end if;
  end loop;
end $$;

delete from public.jobs where id in ('job_ten_a', 'job_ten_b');
delete from public.workspace_vendors where workspace_id = 'ws_ten_a';
delete from public.workspaces where id in ('ws_ten_a', 'ws_ten_b');
