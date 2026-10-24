-- Assertions for 109_engine_reliability.sql (owner: Yash). Self-contained; uses its own job.
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

insert into public.jobs (id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until)
  values ('job_rel', 'RELT', 'collecting', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');

-- Operator reviews: one open row per subject; resolution needs who, when and what; resolved is final.
insert into public.operator_reviews (id, job_id, kind, subject, reason, attempts, last_error) values ('rev_rel1', 'job_rel', 'outbox', 'rfq:job_rel:biz_1', 'not sent after 5 attempts', 5, '503');
select pg_temp.expect_fail('second open review for one subject', $$insert into public.operator_reviews (id, job_id, kind, subject, reason) values ('rev_rel2','job_rel','outbox','rfq:job_rel:biz_1','again')$$);
select pg_temp.expect_fail('unknown review kind', $$insert into public.operator_reviews (id, kind, subject, reason) values ('rev_rel3','whatever','x','y')$$);
select pg_temp.expect_fail('resolved without who', $$update public.operator_reviews set status = 'resolved', resolution = 'done', resolved_at = now() where id = 'rev_rel1'$$);
select pg_temp.expect_fail('review subject changed', $$update public.operator_reviews set subject = 'other' where id = 'rev_rel1'$$);
select pg_temp.expect_fail('oversized last error', $$update public.operator_reviews set last_error = repeat('x', 501) where id = 'rev_rel1'$$);

-- Outbox: an action under open review can't be claimed again; a call with an unknown outcome is never "not sent".
insert into public.outbox (key, job_id, kind, status, attempts) values ('rfq:job_rel:biz_1', 'job_rel', 'email', 'not_sent', 5);
select pg_temp.expect_fail('reviewed action re-claimed', $$update public.outbox set status = 'pending', attempts = 6 where key = 'rfq:job_rel:biz_1'$$);
update public.operator_reviews set status = 'resolved', resolution = 'retry', resolved_by = 'ops', resolved_at = now() where id = 'rev_rel1';
select pg_temp.expect_fail('resolved review reopened', $$update public.operator_reviews set status = 'open', resolution = null, resolved_by = null, resolved_at = null where id = 'rev_rel1'$$);
update public.outbox set status = 'pending', attempts = 6 where key = 'rfq:job_rel:biz_1'; -- allowed once resolved
insert into public.operator_reviews (id, job_id, kind, subject, reason) values ('rev_rel4', 'job_rel', 'outbox', 'rfq:job_rel:biz_1', 'a new failure'); -- a new open one is fine
insert into public.outbox (key, job_id, kind, status) values ('call:job_rel:biz_2', 'job_rel', 'call', 'pending');
update public.outbox set status = 'unknown' where key = 'call:job_rel:biz_2';
select pg_temp.expect_fail('unknown call marked not sent', $$update public.outbox set status = 'not_sent' where key = 'call:job_rel:biz_2'$$);
update public.outbox set status = 'sent', provider_ref = 'call_123' where key = 'call:job_rel:biz_2'; -- recovered from call.ended

-- Not readable by the API roles.
do $$ begin
  if has_table_privilege('anon', 'public.operator_reviews', 'select') or has_table_privilege('authenticated', 'public.operator_reviews', 'select') then
    raise exception 'operator_reviews readable by an API role';
  end if;
end $$;

delete from public.jobs where id = 'job_rel';
\echo 'all reliability assertions passed'
