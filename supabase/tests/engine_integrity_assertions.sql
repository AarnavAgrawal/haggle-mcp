-- Assertions for 115_engine_security.sql (owner: Yash). Self-contained; uses its own workspace and job.
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

insert into public.workspaces (id, name, token_hash) values ('ws_int_test', 'Integrity test', repeat('d', 64));
insert into public.jobs (id, workspace_id, short_code, state, mode, request, payment_cap_cents, inbox, max_rounds, collect_until)
  values ('job_int', 'ws_int_test', 'INTG', 'paying', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_int', 'biz_8888888888888888', 'Harbor', 'harbor@x.test', 'agent', false, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('mint1', 'job_int', 'biz_8888888888888888', 'in', 'reply', 'em_int1', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qint1', 'job_int', 'biz_8888888888888888', 'mint1', 1, 'current', '{}', 115000, 34500, true, '[]', true, 'email body');
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, decided_at)
  values ('apint1', 'job_int', 'qint1', 'biz_8888888888888888', 115000, 34500, 50000, 'imessage', 'approved', '1234', now() + interval '30 minutes', now()),
         ('apint2', 'job_int', 'qint1', 'biz_8888888888888888', 115000, 34500, 50000, 'imessage', 'approved', '5678', now() + interval '30 minutes', now());

-- Stripe: a charge that failed (or whose outcome was recorded as failed) never becomes paid.
select pg_temp.expect_fail('payment inserted as settled', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, stripe_payment_intent_id, simulated) values ('pint0','job_int','apint1','biz_8888888888888888','settled','stripe',34500,'34500','stripe-test','haggle-pay-apint1','pi_3Int0',false)$$);
insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated)
  values ('pint1', 'job_int', 'apint1', 'biz_8888888888888888', 'charging', 'stripe', 34500, '34500', 'stripe-test', 'haggle-pay-apint1', false);
select pg_temp.expect_fail('idempotency key swapped mid-charge', $$update public.payments set idempotency_key = 'haggle-pay-other' where id = 'pint1'$$);
select pg_temp.expect_fail('payment moved to another approval', $$update public.payments set approval_id = 'apint2' where id = 'pint1'$$);
update public.payments set reason = 'retryable:stripe_unreachable' where id = 'pint1'; -- a resumable charge stays charging
update public.payments set status = 'failed', reason = 'card_declined' where id = 'pint1';
select pg_temp.expect_fail('failed charge later marked settled', $$update public.payments set status = 'settled', stripe_payment_intent_id = 'pi_3Int1' where id = 'pint1'$$);
select pg_temp.expect_fail('failed charge resumed', $$update public.payments set status = 'charging' where id = 'pint1'$$);

-- A settled payment is never re-opened or failed afterwards.
delete from public.payments where id = 'pint1';
insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated)
  values ('pint2', 'job_int', 'apint1', 'biz_8888888888888888', 'charging', 'stripe', 34500, '34500', 'stripe-test', 'haggle-pay-apint1', false);
update public.payments set status = 'settled', stripe_payment_intent_id = 'pi_3Int2' where id = 'pint2';
select pg_temp.expect_fail('settled payment re-opened', $$update public.payments set status = 'charging' where id = 'pint2'$$);
select pg_temp.expect_fail('settled payment marked failed', $$update public.payments set status = 'failed' where id = 'pint2'$$);

-- Manual handoff: "the customer reports paying" only from an open handoff.
insert into public.bookings (id, job_id, approval_id, quote_id, business_id, total_cents, payment_cents, status)
  values ('bkint2', 'job_int', 'apint2', 'qint1', 'biz_8888888888888888', 115000, 34500, 'not_in_writing');
select pg_temp.expect_fail('handoff inserted as reported paid', $$insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status, confirmed_by, confirmed_at) values ('hoint2','job_int','apint2','biz_8888888888888888',34500,'human_confirmed','+14155550101',now())$$);
insert into public.payment_handoffs (id, job_id, approval_id, business_id, amount_cents, status)
  values ('hoint2', 'job_int', 'apint2', 'biz_8888888888888888', 34500, 'instructions_requested');
update public.payment_handoffs set status = 'human_confirmed', confirmed_by = '+14155550101', confirmed_at = now() where id = 'hoint2';

delete from public.jobs where id = 'job_int';
delete from public.workspaces where id = 'ws_int_test';
\echo 'all integrity assertions passed'
