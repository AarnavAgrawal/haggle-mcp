-- Assertions run by scripts/verify-migrations.sh against a fresh database.
-- Each block must succeed; "expect failure" blocks raise if the bad write is accepted.
\set ON_ERROR_STOP 1

create or replace function pg_temp.expect_failure(sql text, label text) returns void language plpgsql as $$
begin
  begin
    execute sql;
  exception when others then
    raise notice 'ok (rejected): % -- %', label, sqlerrm;
    return;
  end;
  raise exception 'EXPECTED FAILURE BUT SUCCEEDED: %', label;
end $$;

insert into public.jobs (id, state, intent, title, budget_cents, spend_cap_cents, deadline, reply_by,
                         approver_email, inbox, mode)
values ('job_test0001', 'created', 'lunch for 40', 'Lunch for 40', 120000, 120000,
        '2026-10-22T19:00:00Z', '2026-10-21T19:00:00Z', 'boss@example.com', 'job-test0001@buyer.primitive.email', 'mock');

insert into public.sellers (id, email, kind, domain)
values ('sel_bayc0001', 'baycatering@sellers.example', 'agent', 'sellers.example'),
       ('sel_miss0001', 'missioneats@sellers.example', 'agent', 'sellers.example');

insert into public.email_messages (id, job_id, seller_id, direction, provider_message_id, from_address, to_addresses, subject, kind)
values ('msg_in000001', 'job_test0001', 'sel_bayc0001', 'inbound', 'prov-1', 'baycatering@sellers.example',
        array['job-test0001@buyer.primitive.email'], 'Re: RFQ', 'seller_reply');

-- Webhook replay: same provider event id twice is rejected by the primary key.
insert into public.webhook_events (provider, provider_event_id, event_type, payload) values ('primitive', 'evt_1', 'email.received', '{}');
select pg_temp.expect_failure($q$insert into public.webhook_events (provider, provider_event_id, event_type, payload) values ('primitive', 'evt_1', 'email.received', '{}')$q$, 'duplicate webhook event');

-- Same provider message cannot be stored twice.
select pg_temp.expect_failure($q$insert into public.email_messages (id, job_id, seller_id, direction, provider_message_id, from_address, to_addresses, subject, kind)
  values ('msg_in000002', 'job_test0001', 'sel_bayc0001', 'inbound', 'prov-1', 'x@y.z', array['a@b.c'], 's', 'seller_reply')$q$, 'duplicate provider message id');

-- Quarantine consistency: inbound without a job needs a reason.
select pg_temp.expect_failure($q$insert into public.email_messages (id, job_id, direction, provider_message_id, from_address, to_addresses, subject, kind)
  values ('msg_in000003', null, 'inbound', 'prov-3', 'x@y.z', array['a@b.c'], 's', 'unknown')$q$, 'unmatched inbound without quarantine reason');

-- Cap must be within budget.
select pg_temp.expect_failure($q$insert into public.jobs (id, state, intent, title, budget_cents, spend_cap_cents, deadline, reply_by, approver_email, inbox, mode)
  values ('job_test0002', 'created', 'abc', 't', 100, 200, now() + interval '2 day', now() + interval '1 day', 'a@b.c', 'j2@x.y', 'mock')$q$, 'spend cap above budget');

-- Unknown state rejected.
select pg_temp.expect_failure($q$update public.jobs set state = 'paid' where id = 'job_test0001'$q$, 'unknown job state');

-- Quotes: one current per seller.
insert into public.quotes (id, job_id, seller_id, revision, status, source_message_id, source, total_cents, meets_requirements, confidence, body)
values ('q_bayc0001r1', 'job_test0001', 'sel_bayc0001', 1, 'current', 'msg_in000001', 'quote_json', 115000, 'yes', 0.95, '{}');
select pg_temp.expect_failure($q$insert into public.quotes (id, job_id, seller_id, revision, status, source_message_id, source, total_cents, meets_requirements, confidence, body)
  values ('q_bayc0001r2', 'job_test0001', 'sel_bayc0001', 2, 'current', 'msg_in000001', 'quote_json', 99500, 'yes', 0.95, '{}')$q$, 'two current quotes for one seller');

-- Counteroffer must cite a real competing quote.
select pg_temp.expect_failure($q$insert into public.negotiation_rounds (id, job_id, seller_id, round, kind, target_total_cents, outcome)
  values ('rnd_000001', 'job_test0001', 'sel_miss0001', 1, 'counteroffer', 100000, 'pending')$q$, 'counteroffer without basis');
insert into public.negotiation_rounds (id, job_id, seller_id, round, kind, target_total_cents, basis_quote_id, outcome)
  values ('rnd_000002', 'job_test0001', 'sel_miss0001', 1, 'counteroffer', 110000, 'q_bayc0001r1', 'pending');

-- Approval chain.
insert into public.approval_requests (id, job_id, quote_id, seller_id, quote_revision, quoted_total_cents, max_payment_cents, channel, approver_email, status, expires_at)
values ('apr_req00001', 'job_test0001', 'q_bayc0001r1', 'sel_bayc0001', 1, 115000, 500, 'email', 'boss@example.com', 'pending', now() + interval '1 hour');
select pg_temp.expect_failure($q$insert into public.approval_requests (id, job_id, quote_id, seller_id, quote_revision, quoted_total_cents, max_payment_cents, channel, approver_email, status, expires_at)
  values ('apr_req00002', 'job_test0001', 'q_bayc0001r1', 'sel_bayc0001', 1, 115000, 500, 'email', 'boss@example.com', 'pending', now() + interval '1 hour')$q$, 'second pending approval for job');
select pg_temp.expect_failure($q$insert into public.approval_requests (id, job_id, quote_id, seller_id, quote_revision, quoted_total_cents, max_payment_cents, channel, approver_email, status, expires_at)
  values ('apr_req00003', 'job_test0001', 'q_bayc0001r1', 'sel_bayc0001', 1, 100, 500, 'email', 'boss@example.com', 'declined', now())$q$, 'max payment above quoted total');
insert into public.approval_records (id, request_id, job_id, quote_id, seller_id, quote_revision, approved_max_cents, decision, channel, approver, evidence)
values ('apr_rec00001', 'apr_req00001', 'job_test0001', 'q_bayc0001r1', 'sel_bayc0001', 1, 500, 'approved', 'email', 'boss@example.com', '{"sender_authenticated": true}');

-- Payment: testnet only; one active attempt per job.
insert into public.payment_challenges (id, job_id, seller_id, source_message_id, interaction_id, challenge_step_id, payee_address, issuer_email, issuer_authenticated, network, amount_base_units, asset, status, raw)
values ('chl_000001', 'job_test0001', 'sel_bayc0001', 'msg_in000001', 'abc@sellers.example', 'step1', '0x1111111111111111111111111111111111111111', 'baycatering@sellers.example', true, 'base-sepolia', 5000000, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'held', '{}'),
       ('chl_000002', 'job_test0001', 'sel_bayc0001', 'msg_in000001', 'def@sellers.example', 'step1', '0x1111111111111111111111111111111111111111', 'baycatering@sellers.example', true, 'base-sepolia', 5000000, '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'held', '{}');
select pg_temp.expect_failure($q$insert into public.payment_attempts (id, job_id, challenge_id, approval_id, amount_base_units, network, idempotency_key, status, gateway)
  values ('pay_000000', 'job_test0001', 'chl_000001', 'apr_rec00001', 5000000, 'base', 'k0', 'signing', 'fake')$q$, 'mainnet payment attempt');
insert into public.payment_attempts (id, job_id, challenge_id, approval_id, amount_base_units, network, idempotency_key, status, gateway)
values ('pay_000001', 'job_test0001', 'chl_000001', 'apr_rec00001', 5000000, 'base-sepolia', 'k1', 'signing', 'fake');
select pg_temp.expect_failure($q$insert into public.payment_attempts (id, job_id, challenge_id, approval_id, amount_base_units, network, idempotency_key, status, gateway)
  values ('pay_000002', 'job_test0001', 'chl_000002', 'apr_rec00001', 5000000, 'base-sepolia', 'k2', 'signing', 'fake')$q$, 'second concurrent payment for job');
select pg_temp.expect_failure($q$insert into public.payment_attempts (id, job_id, challenge_id, approval_id, amount_base_units, network, idempotency_key, status, gateway)
  values ('pay_000003', 'job_test0001', 'chl_000001', 'apr_rec00001', 5000000, 'base-sepolia', 'k3', 'failed', 'fake')$q$, 'second attempt on the same challenge');

-- Audit: gap-free sequence and append-only.
select public.haggle_append_event('evt_000001', 'job_test0001', 'job.created', 'buyer_agent', 'created', '{}');
select public.haggle_append_event('evt_000002', 'job_test0001', 'rfq.sent', 'haggle', 'sent', '{}');
do $$ begin
  if (select array_agg(seq order by seq) from public.audit_events where job_id = 'job_test0001') <> array[1::bigint, 2::bigint] then
    raise exception 'audit seq not gap-free';
  end if;
end $$;
select pg_temp.expect_failure($q$update public.audit_events set summary = 'tampered' where id = 'evt_000001'$q$, 'audit update');
select pg_temp.expect_failure($q$delete from public.audit_events where id = 'evt_000001'$q$, 'audit direct delete');

-- Client roles have no access.
set role anon;
select pg_temp.expect_failure($q$select * from public.jobs$q$, 'anon reads jobs');
reset role;
set role authenticated;
select pg_temp.expect_failure($q$select * from public.payment_attempts$q$, 'authenticated reads payments');
select pg_temp.expect_failure($q$select public.haggle_append_event('evt_x00001', 'job_test0001', 'job.hacked', 'human', 'x', '{}')$q$, 'authenticated appends audit event');
reset role;

-- Demo reset: deleting a job cascades through everything, including audit events.
delete from public.payment_attempts where job_id = 'job_test0001'; -- receipts/attempts reference approvals without cascade
delete from public.jobs where id = 'job_test0001';
do $$ begin
  if exists (select 1 from public.audit_events where job_id = 'job_test0001') then raise exception 'cascade failed'; end if;
end $$;

\echo 'all assertions passed'
