-- Assertions for 106_engine_pilot.sql (owner: Yash). Self-contained; uses its own job.
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
  values ('job_pil', 'PILT', 'paying', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_pil', 'biz_8888888888888888', 'Harbor', 'harbor@x.test', 'fleet', true, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('mpil1', 'job_pil', 'biz_8888888888888888', 'in', 'reply', 'em_pil1', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qpil1', 'job_pil', 'biz_8888888888888888', 'mpil1', 1, 'current', '{}', 115000, 34500, true, '[]', true, 'email body');
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action)
  values ('appil1', 'job_pil', 'qpil1', 'biz_8888888888888888', 115000, 34500, 50000, 'imessage', 'pending', '1234', now() + interval '30 minutes', 'pay');

-- Handoffs: only for a human-approved paying approval, at its exact amount and business; final once confirmed.
select pg_temp.expect_fail('handoff for a pending approval', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('ho1','job_pil','appil1','biz_8888888888888888',34500,'instructions_requested')$$);
update public.approvals set status = 'approved', decided_at = now() where id = 'appil1';
-- Since 110 a handoff needs its booking confirmed (here: confirmed by the human directly).
insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status)
  values ('bkpil1', 'job_pil', 'appil1', 'qpil1', 'biz_8888888888888888', 115000, 34500, 'not_in_writing');
-- Since 118 the human must have accepted it (BOOKED <code>) before any handoff.
update public.bookings set human_attested_at = now() where id = 'bkpil1';
select pg_temp.expect_fail('handoff at a different amount', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('ho1','job_pil','appil1','biz_8888888888888888',99999,'instructions_requested')$$);
select pg_temp.expect_fail('handoff confirmed without who/when', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('ho1','job_pil','appil1','biz_8888888888888888',34500,'human_confirmed')$$);
insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('ho1', 'job_pil', 'appil1', 'biz_8888888888888888', 34500, 'instructions_requested');
select pg_temp.expect_fail('second handoff for the same approval', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('ho2','job_pil','appil1','biz_8888888888888888',34500,'instructions_requested')$$);
select pg_temp.expect_fail('handoff amount changed', $$update public.payment_handoffs set amount_cents = 100 where id = 'ho1'$$);
update public.payment_handoffs set status = 'human_confirmed', confirmed_by = '+14155550101', confirmed_at = now() where id = 'ho1';
select pg_temp.expect_fail('confirmed handoff reopened', $$update public.payment_handoffs set status = 'instructions_received', confirmed_by = null, confirmed_at = null where id = 'ho1'$$);

-- Outbox: a sent action is final; a call that may have gone out is never claimed again.
insert into public.outbox (key, job_id, kind, status) values ('call:job_pil:x', 'job_pil', 'call', 'pending'), ('email:job_pil:x', 'job_pil', 'email', 'pending');
update public.outbox set status = 'unknown' where key = 'call:job_pil:x';
select pg_temp.expect_fail('ambiguous call re-claimed', $$update public.outbox set status = 'pending' where key = 'call:job_pil:x'$$);
update public.outbox set status = 'sent', provider_ref = 'em_1' where key = 'email:job_pil:x';
select pg_temp.expect_fail('sent email reopened', $$update public.outbox set status = 'pending' where key = 'email:job_pil:x'$$);
select pg_temp.expect_fail('outbox kind changed', $$update public.outbox set kind = 'text' where key = 'email:job_pil:x'$$);
insert into public.outbox (key, job_id, kind, status) values ('call:job_pil:y', 'job_pil', 'call', 'not_sent');
update public.outbox set status = 'pending', attempts = 2 where key = 'call:job_pil:y'; -- a definite refusal may be retried

-- Leases, suppressions, workspace vendors: shapes and normalisation.
insert into public.job_leases (job_id, owner, expires_at) values ('job_pil', 'proc_a', now() + interval '5 minutes');
select pg_temp.expect_fail('two leases for one job', $$insert into public.job_leases (job_id, owner, expires_at) values ('job_pil','proc_b',now())$$);
select pg_temp.expect_fail('suppression not lowercased', $$insert into public.vendor_suppressions (contact, reason) values ('Harbor@X.test','opt_out')$$);
select pg_temp.expect_fail('suppression with unknown reason', $$insert into public.vendor_suppressions (contact, reason) values ('harbor@x.test','annoyed')$$);
insert into public.vendor_suppressions (contact, reason, job_id) values ('harbor@x.test', 'opt_out', 'job_pil');
select pg_temp.expect_fail('vendor without consent', $$insert into public.workspace_vendors (workspace_id, contact, name, consent, added_by) values ('ws_default','v@x.test','V','','op')$$);
insert into public.workspace_vendors (workspace_id, contact, name, consent, added_by) values ('ws_default', 'v@x.test', 'V', 'agreed by phone', 'operator');

delete from public.jobs where id = 'job_pil';
delete from public.vendor_suppressions where contact = 'harbor@x.test';
delete from public.workspace_vendors where contact = 'v@x.test';
\echo 'all pilot assertions passed'
