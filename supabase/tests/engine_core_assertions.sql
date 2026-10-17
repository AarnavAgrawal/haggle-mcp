-- Negative assertions for 100_engine_core.sql: each statement must be rejected by the database.
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
  values ('job_live', 'LIVE', 'collecting', 'live', '{}', 500, 'job-live@x.test', 2, now() + interval '1 hour'),
         ('job_mock', 'MOCK', 'collecting', 'mock', '{}', 500, 'job-mock@x.test', 2, now() + interval '1 hour');
insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status)
  values ('job_live', 'biz_0123456789abcdef', 'Bay', 'quotes@bay.test', 'agent', false, 'contacted'),
         ('job_mock', 'biz_0123456789abcdef', 'Bay', 'quotes@bay.test', 'fleet', true, 'contacted');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status) values
  ('m1', 'job_live', 'biz_0123456789abcdef', 'in', 'reply', 'em_1', 'done'),
  ('m2', 'job_live', 'biz_0123456789abcdef', 'in', 'reply', 'em_2', 'done');
insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source)
  values ('q1', 'job_live', 'biz_0123456789abcdef', 'm1', 1, 'current', '{}', 99500, 500, true, '[]', true, 'quote.json');
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at)
  values ('ap1', 'job_live', 'q1', 'biz_0123456789abcdef', 99500, 500, 500, 'email', 'pending', '4821', now() + interval '30 minutes');
insert into public.payments (id, job_id, approval_id, business_id, status, amount_cents, amount_base_units, network, simulated)
  values ('p1', 'job_live', 'ap1', 'biz_0123456789abcdef', 'awaiting_invoice', 500, '5000000', 'base-sepolia', false);

select pg_temp.expect_fail('unknown job state', $$update public.jobs set state = 'ready' where id = 'job_live'$$);
-- 102: the x402 $10 ceiling moved onto x402 payment rows (see engine_stripe_assertions.sql).
select pg_temp.expect_fail('payment cap above the hard ceiling', $$update public.jobs set payment_cap_cents = 1000001 where id = 'job_live'$$);
select pg_temp.expect_fail('business snapshot changed', $$update public.job_businesses set email = 'evil@x.test' where job_id = 'job_live'$$);
select pg_temp.expect_fail('uppercase snapshot email', $$insert into public.job_businesses (job_id, business_id, name, email, source, simulated, status) values ('job_live','biz_1111111111111111','X','Up@X.test','agent',false,'pending')$$);
select pg_temp.expect_fail('duplicate inbound email', $$insert into public.messages (id, job_id, direction, kind, provider_email_id, parse_status) values ('m3','job_live','in','reply','em_1','none')$$);
select pg_temp.expect_fail('outbound without idempotency key', $$insert into public.messages (id, job_id, direction, kind, parse_status) values ('m4','job_live','out','rfq','none')$$);
select pg_temp.expect_fail('duplicate idempotency key', $$insert into public.messages (id, job_id, direction, kind, idempotency_key, parse_status) values ('m5','job_live','out','rfq','rfq:k','none'), ('m6','job_live','out','rfq','rfq:k','none')$$);
select pg_temp.expect_fail('second quote from one message', $$insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, compliant, requirement_results, sender_trusted, source) values ('q2','job_live','biz_0123456789abcdef','m1',2,'superseded','{}',100,false,'[]',true,'x')$$);
select pg_temp.expect_fail('two current quotes per business', $$insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, compliant, requirement_results, sender_trusted, source) values ('q3','job_live','biz_0123456789abcdef','m2',2,'current','{}',100,false,'[]',true,'x')$$);
select pg_temp.expect_fail('deposit above total', $$update public.quotes set deposit_cents = 100000 where id = 'q1'$$);
select pg_temp.expect_fail('compliant quote without total', $$update public.quotes set total_cents = null where id = 'q1'$$);
select pg_temp.expect_fail('second pending approval', $$insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at) values ('ap2','job_live','q1','biz_0123456789abcdef',99500,500,500,'email','pending','1111',now())$$);
select pg_temp.expect_fail('approval over cap', $$update public.approvals set payment_cents = 600 where id = 'ap1'$$);
select pg_temp.expect_fail('simulated approval on a live job', $$update public.approvals set channel = 'simulated' where id = 'ap1'$$);
select pg_temp.expect_fail('mainnet payment', $$update public.payments set network = 'base' where id = 'p1'$$);
select pg_temp.expect_fail('base units not exact cents', $$update public.payments set amount_base_units = '5000001' where id = 'p1'$$);
select pg_temp.expect_fail('signed while approval pending', $$update public.payments set status = 'signed', challenge_step_id = 's1', challenge_trusted = true, challenge_thread_matched = true where id = 'p1'$$);
update public.approvals set status = 'approved', decided_at = now() where id = 'ap1';
select pg_temp.expect_fail('settled without tx', $$update public.payments set status = 'settled', challenge_step_id = 's1', challenge_trusted = true, challenge_thread_matched = true where id = 'p1'$$);
select pg_temp.expect_fail('signed without trusted challenge', $$update public.payments set status = 'signed', challenge_step_id = 's1' where id = 'p1'$$);
insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, channel, status, code, expires_at, decided_at)
  values ('ap3', 'job_live', 'q1', 'biz_0123456789abcdef', 99500, 500, 500, 'email', 'declined', '2222', now(), now());
select pg_temp.expect_fail('second active payment for a job', $$insert into public.payments (id, job_id, approval_id, business_id, status, amount_cents, amount_base_units, network, simulated) values ('p2','job_live','ap3','biz_0123456789abcdef','awaiting_invoice',500,'5000000','base-sepolia',false)$$);
select pg_temp.expect_fail('payment amount differs from approval', $$insert into public.payments (id, job_id, approval_id, business_id, status, amount_cents, amount_base_units, network, simulated) values ('p3','job_live','ap3','biz_0123456789abcdef','failed',400,'4000000','base-sepolia',false)$$);
select public.haggle_append_event('job_live', 'state', '{}');
select pg_temp.expect_fail('audit event edited', $$update public.job_events set type = 'x' where job_id = 'job_live'$$);
select pg_temp.expect_fail('audit event deleted', $$delete from public.job_events where job_id = 'job_live'$$);
select pg_temp.expect_fail('anon reads jobs', $$set local role anon; select * from public.jobs$$);
reset role;

-- Positive: event sequence is gap-free, and deleting a job cascades through the audit trail.
do $$ begin
  perform public.haggle_append_event('job_live', 'reply', '{}');
  if (select array_agg(seq order by seq) from public.job_events where job_id = 'job_live') <> array[1,2] then raise exception 'seq not gap-free'; end if;
end $$;
delete from public.jobs where id = 'job_mock';
\echo all engine assertions passed
