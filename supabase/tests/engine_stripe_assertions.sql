-- Assertions for 102_engine_stripe.sql (owner: Yash). Self-contained; uses its own job.
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
  values ('job_st', 'STRP', 'paying', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_st', 'biz_5555555555555555', 'Harbor', 'harbor@x.test', 'fleet', true, 'quoted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status)
  values ('ms1', 'job_st', 'biz_5555555555555555', 'in', 'reply', 'em_st1', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('qs1', 'job_st', 'biz_5555555555555555', 'ms1', 1, 'current', '{}', 112000, 30000, true, '[]', true, 'pdf p.1');
-- A $300 deposit is approvable now (was capped at $10 for x402).
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at)
  values ('aps1', 'job_st', 'qs1', 'biz_5555555555555555', 112000, 30000, 50000, 'view', 'pending', '1234', now() + interval '30 minutes');

select pg_temp.expect_fail('stripe charge while approval pending', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated) values ('ps1','job_st','aps1','biz_5555555555555555','charging','stripe',30000,'30000','stripe-test','haggle-pay-aps1',false)$$);
update public.approvals set status = 'approved', decided_at = now() where id = 'aps1';
select pg_temp.expect_fail('stripe amount differs from approval', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated) values ('ps1','job_st','aps1','biz_5555555555555555','charging','stripe',29999,'29999','stripe-test','haggle-pay-aps1',false)$$);
select pg_temp.expect_fail('stripe without idempotency key', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, simulated) values ('ps1','job_st','aps1','biz_5555555555555555','charging','stripe',30000,'30000','stripe-test',false)$$);
select pg_temp.expect_fail('stripe on a crypto network', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated) values ('ps1','job_st','aps1','biz_5555555555555555','charging','stripe',30000,'30000','base-sepolia','haggle-pay-aps1',false)$$);
select pg_temp.expect_fail('x402 rail above $10', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, simulated) values ('ps1','job_st','aps1','biz_5555555555555555','awaiting_invoice','x402',30000,'300000000','base-sepolia',false)$$);
select pg_temp.expect_fail('stripe using an x402 status', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated) values ('ps1','job_st','aps1','biz_5555555555555555','awaiting_invoice','stripe',30000,'30000','stripe-test','haggle-pay-aps1',false)$$);
insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated)
  values ('ps1', 'job_st', 'aps1', 'biz_5555555555555555', 'charging', 'stripe', 30000, '30000', 'stripe-test', 'haggle-pay-aps1', false);
select pg_temp.expect_fail('settled without a PaymentIntent', $$update public.payments set status = 'settled' where id = 'ps1'$$);
select pg_temp.expect_fail('malformed PaymentIntent id', $$update public.payments set status = 'settled', stripe_payment_intent_id = 'ch_123' where id = 'ps1'$$);
select pg_temp.expect_fail('second payment for the same approval', $$insert into public.payments (id, job_id, approval_id, business_id, status, rail, amount_cents, amount_base_units, network, idempotency_key, simulated) values ('ps2','job_st','aps1','biz_5555555555555555','charging','stripe',30000,'30000','stripe-test','haggle-pay-aps1-b',false)$$);
select pg_temp.expect_fail('cap above the hard ceiling', $$update public.jobs set payment_cap_cents = 1000001 where id = 'job_st'$$);
-- Positive: a valid PaymentIntent settles it.
update public.payments set status = 'settled', stripe_payment_intent_id = 'pi_3Test123' where id = 'ps1';
delete from public.jobs where id = 'job_st';
\echo all stripe assertions passed
