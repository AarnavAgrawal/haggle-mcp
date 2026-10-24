-- Assertions for 110_engine_booking.sql (owner: Yash, workstream D). Self-contained; uses its own job.
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
  values ('job_bk', 'BKNG', 'paying', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_bk', 'biz_7777777777777777', 'Harbor', 'harbor@x.test', 'agent', false, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('mbk1', 'job_bk', 'biz_7777777777777777', 'in', 'reply', 'em_bk1', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qbk1', 'job_bk', 'biz_7777777777777777', 'mbk1', 1, 'current', '{}', 115000, 34500, true, '[]', true, 'email body');
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, action)
  values ('apbk1', 'job_bk', 'qbk1', 'biz_7777777777777777', 115000, 34500, 50000, 'imessage', 'pending', '4321', now() + interval '30 minutes', 'pay');

-- A booking needs the human's approval, at exactly its quote, business and amounts.
select pg_temp.expect_fail('booking for a pending approval', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status) values ('bk1','job_bk','apbk1','qbk1','biz_7777777777777777',115000,34500,'awaiting_vendor_confirmation')$$);
update public.approvals set status = 'approved', decided_at = now() where id = 'apbk1';
select pg_temp.expect_fail('booking at another total', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status) values ('bk1','job_bk','apbk1','qbk1','biz_7777777777777777',99999,34500,'awaiting_vendor_confirmation')$$);
select pg_temp.expect_fail('booking born confirmed', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status, confirmed_at) values ('bk1','job_bk','apbk1','qbk1','biz_7777777777777777',115000,34500,'confirmed',now())$$);
insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status)
  values ('bk1', 'job_bk', 'apbk1', 'qbk1', 'biz_7777777777777777', 115000, 34500, 'awaiting_vendor_confirmation');
select pg_temp.expect_fail('second booking for the approval', $$insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status) values ('bk2','job_bk','apbk1','qbk1','biz_7777777777777777',115000,34500,'awaiting_vendor_confirmation')$$);

-- No payment handoff before the business confirms the booking.
select pg_temp.expect_fail('handoff before booking confirmed', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hobk','job_bk','apbk1','biz_7777777777777777',34500,'instructions_requested')$$);
select pg_temp.expect_fail('confirmed without confirmed_at', $$update public.bookings set status = 'confirmed' where id = 'bk1'$$);
select pg_temp.expect_fail('booking terms changed', $$update public.bookings set total_cents = 1 where id = 'bk1'$$);
update public.bookings set status = 'confirmed', confirmed_at = now(), reply_text = 'Confirmed! Zelle pay@harbor', reply_has_link = false where id = 'bk1';
select pg_temp.expect_fail('confirmed booking reopened', $$update public.bookings set status = 'awaiting_vendor_confirmation', confirmed_at = null where id = 'bk1'$$);
insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status) values ('hobk', 'job_bk', 'apbk1', 'biz_7777777777777777', 34500, 'instructions_requested');
update public.payment_handoffs set stalled_at = now() where id = 'hobk';

-- A receipt only after the customer reported paying; final once recorded.
select pg_temp.expect_fail('receipt before the customer reported paying', $$insert into public.handoff_receipts (id, handoff_id, job_id, message_id, evidence) values ('rc1','hobk','job_bk','mbk1','received')$$);
update public.payment_handoffs set status = 'human_confirmed', confirmed_by = '+14155550101', confirmed_at = now() where id = 'hobk';
select pg_temp.expect_fail('receipt without evidence', $$insert into public.handoff_receipts (id, handoff_id, job_id, message_id, evidence) values ('rc1','hobk','job_bk','mbk1','')$$);
insert into public.handoff_receipts (id, handoff_id, job_id, message_id, evidence) values ('rc1', 'hobk', 'job_bk', 'mbk1', 'Got the deposit, thanks!');
select pg_temp.expect_fail('second receipt', $$insert into public.handoff_receipts (id, handoff_id, job_id, message_id, evidence) values ('rc2','hobk','job_bk','mbk1','again')$$);
select pg_temp.expect_fail('receipt edited', $$update public.handoff_receipts set evidence = 'x' where id = 'rc1'$$);

-- A confirmed booking can only be cancelled; a cancelled one is final.
update public.bookings set status = 'cancelled', cancel_reason = 'customer cancelled' where id = 'bk1';
select pg_temp.expect_fail('cancelled booking revived', $$update public.bookings set status = 'confirmed' where id = 'bk1'$$);

delete from public.jobs where id = 'job_bk';
\echo 'all booking assertions passed'
