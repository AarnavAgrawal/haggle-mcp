-- Assertions for 105_engine_security.sql (owner: Yash). Self-contained; uses its own job.
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

insert into public.workspaces (id, name, token_hash) values ('ws_sec_test', 'Security test', repeat('c', 64));
insert into public.jobs (id, workspace_id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until)
  values ('job_sec', 'ws_sec_test', 'SECU', 'collecting', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_sec', 'biz_6666666666666666', 'Harbor', 'harbor@x.test', 'fleet', true, 'quoted'),
         ('job_sec', 'biz_7777777777777777', 'Sunset', 'sunset@x.test', 'fleet', true, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('msec1', 'job_sec', 'biz_6666666666666666', 'in', 'reply', 'em_sec1', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qsec1', 'job_sec', 'biz_6666666666666666', 'msec1', 1, 'current', '{"terms":{"deposit_terms":"30% now"}}', 115000, 34500, true, '[]', true, 'email body');

-- Quotes: only the status may change.
select pg_temp.expect_fail('quote total changed in place', $$update public.quotes set total_cents = 99000 where id = 'qsec1'$$);
select pg_temp.expect_fail('quote deposit changed in place', $$update public.quotes set deposit_cents = 1000 where id = 'qsec1'$$);
select pg_temp.expect_fail('quote terms changed in place', $$update public.quotes set record = '{"terms":{"deposit_terms":"100% now"}}' where id = 'qsec1'$$);
select pg_temp.expect_fail('quote moved to another business', $$update public.quotes set business_id = 'biz_7777777777777777' where id = 'qsec1'$$);
update public.quotes set status = 'superseded' where id = 'qsec1';
update public.quotes set status = 'current' where id = 'qsec1';

-- Approvals: the quote's own job, business and total.
select pg_temp.expect_fail('approval naming another business', $$insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at) values ('apsec1','job_sec','qsec1','biz_7777777777777777',115000,34500,50000,'imessage','pending','1234',now() + interval '30 minutes')$$);
select pg_temp.expect_fail('approval at a different total', $$insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at) values ('apsec1','job_sec','qsec1','biz_6666666666666666',100000,34500,50000,'imessage','pending','1234',now() + interval '30 minutes')$$);
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at)
  values ('apsec1', 'job_sec', 'qsec1', 'biz_6666666666666666', 115000, 34500, 50000, 'imessage', 'pending', '1234', now() + interval '30 minutes');

-- Workspaces: revocation is a timestamp; credentials stay unique.
update public.workspaces set revoked_at = now() where id = 'ws_sec_test';
do $$ begin
  if (select revoked_at from public.workspaces where id = 'ws_sec_test') is null then raise exception 'revoked_at not stored'; end if;
end $$;

delete from public.jobs where id = 'job_sec';
delete from public.workspaces where id = 'ws_sec_test';
\echo 'all security assertions passed'
