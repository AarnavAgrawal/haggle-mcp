-- Assertions for 113_engine_purchasing.sql (owner: Yash, sprint 4 workstream B). Self-contained; uses its own job.
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
  values ('job_pc', 'PRCH', 'paying', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_pc', 'biz_8888888888888888', 'Harbor', 'harbor@x.test', 'agent', false, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('mpc1', 'job_pc', 'biz_8888888888888888', 'in', 'reply', 'em_pc1', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qpc1', 'job_pc', 'biz_8888888888888888', 'mpc1', 1, 'current', '{}', 115000, 34500, true, '[]', true, 'email body');
-- A confirm-only approval (pays nothing) and a paying one on another quote row.
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action, decided_at)
  values ('appc1', 'job_pc', 'qpc1', 'biz_8888888888888888', 115000, 0, 50000, 'imessage', 'approved', '4321', now() + interval '30 minutes', 'confirm', now());

-- A confirm-only booking pays nothing, and can't claim an amount.
select pg_temp.expect_fail('confirm-only booking with an amount', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status) values ('bkpc1','job_pc','appc1','qpc1','biz_8888888888888888',115000,34500,'awaiting_vendor_confirmation')$$);
select pg_temp.expect_fail('negative booking amount', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status) values ('bkpc1','job_pc','appc1','qpc1','biz_8888888888888888',115000,-1,'awaiting_vendor_confirmation')$$);
insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status)
  values ('bkpc1', 'job_pc', 'appc1', 'qpc1', 'biz_8888888888888888', 115000, 0, 'awaiting_vendor_confirmation');
update public.bookings set status = 'confirmed', confirmed_at = now(), reply_text = 'Confirmed for the 14th.' where id = 'bkpc1';
-- Never a payment handoff for a confirm-only booking, even once confirmed.
select pg_temp.expect_fail('handoff for a confirm-only booking', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hopc','job_pc','appc1','biz_8888888888888888',0,'instructions_requested')$$);

-- A paying approval still can't book zero (110's rule, now in the trigger).
update public.bookings set status = 'cancelled', cancel_reason = 'test' where id = 'bkpc1';
update public.approvals set status = 'expired' where id = 'appc1';
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action, decided_at)
  values ('appc2', 'job_pc', 'qpc1', 'biz_8888888888888888', 115000, 34500, 50000, 'imessage', 'approved', '1234', now() + interval '30 minutes', 'pay', now());
select pg_temp.expect_fail('paying booking for zero', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status) values ('bkpc2','job_pc','appc2','qpc1','biz_8888888888888888',115000,0,'awaiting_vendor_confirmation')$$);
insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status)
  values ('bkpc2', 'job_pc', 'appc2', 'qpc1', 'biz_8888888888888888', 115000, 34500, 'awaiting_vendor_confirmation');
select pg_temp.expect_fail('handoff before the paying booking is confirmed', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hopc2','job_pc','appc2','biz_8888888888888888',34500,'instructions_requested')$$);
update public.bookings set status = 'confirmed', confirmed_at = now() where id = 'bkpc2';
insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hopc2', 'job_pc', 'appc2', 'biz_8888888888888888', 34500, 'instructions_requested');

delete from public.jobs where id = 'job_pc';
\echo 'all purchasing assertions passed'
