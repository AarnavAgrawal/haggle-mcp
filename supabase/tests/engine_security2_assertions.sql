-- Assertions for 121_engine_security2.sql (owner: Yash). Self-contained; uses its own job.
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

insert into public.workspaces (id, name, token_hash) values ('ws_sec2_test', 'Security 2 test', repeat('d', 64));
insert into public.jobs (id, workspace_id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until)
  values ('job_sec2', 'ws_sec2_test', 'SEC2', 'collecting', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_sec2', 'biz_8888888888888888', 'Harbor', 'harbor2@x.test', 'fleet', true, 'quoted'),
         ('job_sec2', 'biz_9999999999999999', 'Sunset', 'sunset2@x.test', 'fleet', true, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('msec2a', 'job_sec2', 'biz_8888888888888888', 'in', 'reply', 'em_sec2a', 'done'),
         ('msec2b', 'job_sec2', 'biz_9999999999999999', 'in', 'reply', 'em_sec2b', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qsec2a', 'job_sec2', 'biz_8888888888888888', 'msec2a', 1, 'current', '{}', 115000, 34500, true, '[]', true, 'email body'),
         ('qsec2b', 'job_sec2', 'biz_9999999999999999', 'msec2b', 1, 'current', '{}', 90000, 20000, true, '[]', true, 'email body');
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action)
  values ('apsec2', 'job_sec2', 'qsec2a', 'biz_8888888888888888', 115000, 34500, 50000, 'imessage', 'pending', '1234', now() + interval '30 minutes', 'pay');

-- Terms: never changed in place.
select pg_temp.expect_fail('approval moved to another quote', $$update public.approvals set quote_id = 'qsec2b' where id = 'apsec2'$$);
select pg_temp.expect_fail('approval moved to another business', $$update public.approvals set business_id = 'biz_9999999999999999' where id = 'apsec2'$$);
select pg_temp.expect_fail('approval payment changed', $$update public.approvals set payment_cents = 100 where id = 'apsec2'$$);
select pg_temp.expect_fail('approval total changed', $$update public.approvals set quote_total_cents = 90000 where id = 'apsec2'$$);
select pg_temp.expect_fail('approval cap raised', $$update public.approvals set cap_cents = 900000 where id = 'apsec2'$$);
select pg_temp.expect_fail('approval action changed', $$update public.approvals set action = 'confirm' where id = 'apsec2'$$);

-- Recording a decision still works: attempts, thread, outbound message, channel and approver.
update public.approvals set attempts = attempts + 1, thread_id = 't1', outbound_message_id = '<m1@x>' where id = 'apsec2';
update public.approvals set status = 'declined', decided_at = now(), channel = 'imessage', approver = '+14155550101' where id = 'apsec2';

-- Status: a decided approval never comes back.
select pg_temp.expect_fail('declined approval re-approved', $$update public.approvals set status = 'approved' where id = 'apsec2'$$);
select pg_temp.expect_fail('declined approval re-opened', $$update public.approvals set status = 'pending', decided_at = null where id = 'apsec2'$$);
select pg_temp.expect_fail('declined approval marked used', $$update public.approvals set status = 'used' where id = 'apsec2'$$);
update public.approvals set status = 'expired' where id = 'apsec2';

insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action)
  values ('apsec2b', 'job_sec2', 'qsec2a', 'biz_8888888888888888', 115000, 34500, 50000, 'imessage', 'pending', '5678', now() + interval '30 minutes', 'pay');
update public.approvals set status = 'approved', decided_at = now() where id = 'apsec2b';
update public.approvals set status = 'used' where id = 'apsec2b';
select pg_temp.expect_fail('used approval re-approved', $$update public.approvals set status = 'approved' where id = 'apsec2b'$$);

delete from public.jobs where id = 'job_sec2';
delete from public.workspaces where id = 'ws_sec2_test';
\echo 'all security2 assertions passed'
