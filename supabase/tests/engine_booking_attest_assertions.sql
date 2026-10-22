-- Assertions for 118_engine_booking.sql (owner: Yash, sprint 5 workstream A). Self-contained; uses its own job.
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
  values ('job_at', 'ATST', 'paying', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, phone, channel, source, simulated, status)
  values ('job_at', 'biz_7777777777777777', 'Mission Eats', '+14155550188', 'phone', 'agent', false, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('mat1', 'job_at', 'biz_7777777777777777', 'in', 'reply', 'call-ended:at1', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qat1', 'job_at', 'biz_7777777777777777', 'mat1', 1, 'current', '{}', 170000, 30000, true, '[]', true, 'call transcript');
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action, decided_at)
  values ('apat1', 'job_at', 'qat1', 'biz_7777777777777777', 170000, 30000, 50000, 'imessage', 'approved', '4242', now() + interval '30 minutes', 'pay', now());

-- A booking starts unattested.
select pg_temp.expect_fail('booking inserted as attested', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status, human_attested_at) values ('bkat1','job_at','apat1','qat1','biz_7777777777777777',170000,30000,'not_in_writing',now())$$);
insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status)
  values ('bkat1', 'job_at', 'apat1', 'qat1', 'biz_7777777777777777', 170000, 30000, 'not_in_writing');
-- Not in writing and not accepted by the human: no payment handoff.
select pg_temp.expect_fail('handoff before the human accepted the booking', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hoat1','job_at','apat1','biz_7777777777777777',30000,'instructions_requested')$$);
update public.bookings set human_attested_at = now() where id = 'bkat1';
select pg_temp.expect_fail('attestation changed', $$update public.bookings set human_attested_at = now() + interval '1 minute' where id = 'bkat1'$$);
select pg_temp.expect_fail('attestation cleared', $$update public.bookings set human_attested_at = null where id = 'bkat1'$$);
insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hoat1', 'job_at', 'apat1', 'biz_7777777777777777', 30000, 'instructions_requested');
-- Cancelling an attested booking keeps the record of who confirmed it.
update public.bookings set status = 'cancelled', cancel_reason = 'test' where id = 'bkat1';

-- A booking awaiting the vendor's written yes is never "attested" by the human (that's BOOKED on a claim, which confirms it).
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action, decided_at)
  values ('apat2', 'job_at', 'qat1', 'biz_7777777777777777', 170000, 30000, 50000, 'imessage', 'approved', '4343', now() + interval '30 minutes', 'pay', now());
insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status)
  values ('bkat2', 'job_at', 'apat2', 'qat1', 'biz_7777777777777777', 170000, 30000, 'awaiting_vendor_confirmation');
select pg_temp.expect_fail('written booking attested', $$update public.bookings set human_attested_at = now() where id = 'bkat2'$$);
select pg_temp.expect_fail('handoff before the vendor confirmed', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hoat2','job_at','apat2','biz_7777777777777777',30000,'instructions_requested')$$);
update public.bookings set status = 'confirmed', confirmed_at = now() where id = 'bkat2';
insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hoat2', 'job_at', 'apat2', 'biz_7777777777777777', 30000, 'instructions_requested');

delete from public.jobs where id = 'job_at';
\echo 'all booking attestation assertions passed'
