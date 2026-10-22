-- Rows as the v5 demo-era server wrote them on a database at migration 102 (the live database's
-- state per the sprint-4 audit: 100-102 applied, no ledger). scripts/migration-compat.sh loads this
-- on a 100-102 database, then applies 103..latest one file at a time (as the operator would, each in
-- one transaction) and runs check_upgraded.sql. A later migration that can't apply over existing
-- rows (a NOT NULL column without a default, a narrowed CHECK, a trigger that fires on old rows)
-- fails here, not on the live database. Synthetic data only; schema of 100-102 only.

insert into public.engine_settings (id, spending_cap_cents, approver_phone, approver_email, default_area)
values (1, 150000, '+14155550123', 'ops@buyer.example', 'San Francisco, CA');

insert into public.jobs (id, short_code, state, mode, request, budget_cents, payment_cap_cents, approver_email, inbox, round, max_rounds, collect_until, ready, pay_intent, client_request_id) values
  ('job_compat_paid', 'CMPA1', 'paid', 'mock', '{"what":"lunch catering","quantity":20,"unit":"people","date":"2026-10-30","area":"San Francisco, CA","requirements":[]}', 80000, 50000, 'ops@buyer.example', 'haggle@inbox.example', 1, 2, now() - interval '3 days', true, true, 'compat-req-1'),
  ('job_compat_open', 'CMPA2', 'collecting', 'live', '{"what":"breakfast for 40","quantity":40,"unit":"people","date":"2026-11-12","area":"Oakland, CA","requirements":["vegetarian options"]}', 120000, 60000, null, 'haggle@inbox.example', 1, 2, now() + interval '1 hour', false, false, 'compat-req-2'),
  ('job_compat_cxl', 'CMPA3', 'cancelled', 'live', '{"what":"coffee service","quantity":15}', null, 10000, null, 'haggle@inbox.example', 1, 1, now() - interval '9 days', false, false, null),
  ('job_compat_fail', 'CMPA4', 'failed', 'mock', '{"what":"dinner"}', 30000, 1000, null, 'haggle@inbox.example', 2, 2, now() - interval '20 days', true, false, null);
update public.jobs set failure_reason = 'no business replied' where id = 'job_compat_fail';

insert into public.job_businesses (job_id, business_id, name, email, phone, channel, source, simulated, status, thread_id, contacted_at, last_reply_at, followups_sent, countered_round) values
  ('job_compat_paid', 'biz_00000000000000a1', 'Mission Eats (DEMO)', 'orders@missioneats.example', null, 'email', 'fleet', true, 'quoted', 'th_compat_1', now() - interval '3 days', now() - interval '3 days', 0, 1),
  ('job_compat_paid', 'biz_00000000000000a2', 'Bay Catering (DEMO)', 'hello@baycatering.example', null, 'email', 'fleet', true, 'declined', 'th_compat_2', now() - interval '3 days', now() - interval '3 days', 1, 0),
  ('job_compat_open', 'biz_00000000000000a3', 'Harbor Table', 'events@harbortable.example', null, 'email', 'agent', false, 'question', 'th_compat_3', now() - interval '1 hour', now() - interval '30 minutes', 0, 0),
  ('job_compat_open', 'biz_00000000000000a4', 'Sunset Kitchen', null, '+14155550177', 'phone', 'web', false, 'ringing', null, now() - interval '10 minutes', null, 0, 0),
  ('job_compat_cxl', 'biz_00000000000000a5', 'Golden Grill', 'orders@goldengrill.example', '+14155550188', 'email', 'agent', false, 'contacted', 'th_compat_5', now() - interval '9 days', null, 2, 0);

insert into public.messages (id, job_id, business_id, direction, kind, channel, provider_email_id, idempotency_key, rfc_message_id, thread_id, from_address, to_address, subject, body_text, sender_trusted, trust_reason, matched_via, parse_status, round, simulated, quarantine_reason) values
  ('msg_compat_rfq1', 'job_compat_paid', 'biz_00000000000000a1', 'out', 'rfq', 'email', 'em_out_1', 'idem_rfq_1', '<rfq1@inbox.example>', 'th_compat_1', 'haggle@inbox.example', 'orders@missioneats.example', 'Quote request: lunch catering', 'Hello, could you quote lunch for 20?', null, null, null, 'none', 1, true, null),
  ('msg_compat_rep1', 'job_compat_paid', 'biz_00000000000000a1', 'in', 'reply', 'email', 'em_in_1', null, '<rep1@missioneats.example>', 'th_compat_1', 'orders@missioneats.example', 'haggle@inbox.example', 'Re: Quote request: lunch catering', '$600 total, $150 deposit.', true, 'fleet', 'thread', 'done', 1, true, null),
  ('msg_compat_rep2', 'job_compat_open', 'biz_00000000000000a3', 'in', 'reply', 'email', 'em_in_2', null, '<rep2@harbortable.example>', 'th_compat_3', 'events@harbortable.example', 'haggle@inbox.example', 'Re: Quote request: breakfast for 40', 'Buffet or boxed?', true, 'outbound-verified', 'thread', 'done', 1, false, null),
  ('msg_compat_call', 'job_compat_open', 'biz_00000000000000a4', 'out', 'call', 'phone', null, 'idem_call_1', null, null, null, '+14155550177', null, 'AI assistant requesting a quote', null, null, null, 'none', 1, false, null),
  ('msg_compat_quar', 'job_compat_cxl', 'biz_00000000000000a5', 'in', 'quarantine', 'email', 'em_in_3', null, '<q3@elsewhere.example>', null, 'someone@elsewhere.example', 'haggle@inbox.example', 'Re: invoice', 'pay here', false, 'unverified-external-sender', null, 'none', null, false, 'unverified sender');

insert into public.quotes (id, job_id, business_id, message_id, round, status, record, total_cents, deposit_cents, compliant, requirement_results, sender_trusted, source) values
  ('q_compat_1', 'job_compat_paid', 'biz_00000000000000a1', 'msg_compat_rep1', 1, 'current', '{"total_usd":600,"deposit_usd":150,"items":["sandwich platters"]}', 60000, 15000, true, '[]', true, 'email body');

insert into public.questions (id, job_id, business_id, message_id, text, status) values
  ('qn_compat_1', 'job_compat_open', 'biz_00000000000000a3', 'msg_compat_rep2', 'Buffet or boxed?', 'pending');

insert into public.approvals (id, job_id, quote_id, business_id, quote_total_cents, payment_cents, cap_cents, approver, channel, status, code, expires_at, decided_at) values
  ('ap_compat_1', 'job_compat_paid', 'q_compat_1', 'biz_00000000000000a1', 60000, 15000, 50000, 'human (approval view)', 'view', 'used', '4821', now() - interval '3 days' + interval '30 minutes', now() - interval '3 days');

-- A settled Stripe test-mode deposit, written the way 102-era code did: charging, then settled.
insert into public.payments (id, job_id, approval_id, business_id, status, amount_cents, amount_base_units, network, rail, idempotency_key, simulated) values
  ('pay_compat_1', 'job_compat_paid', 'ap_compat_1', 'biz_00000000000000a1', 'charging', 15000, '15000', 'stripe-test', 'stripe', 'idem_pay_1', true);
update public.payments set status = 'settled', stripe_payment_intent_id = 'pi_compat1' where id = 'pay_compat_1';

select public.haggle_append_event('job_compat_paid', 'created', '{}');
select public.haggle_append_event('job_compat_paid', 'quote', '{"quote_id":"q_compat_1"}');
select public.haggle_append_event('job_compat_paid', 'paid', '{"payment_id":"pay_compat_1"}');
select public.haggle_append_event('job_compat_open', 'created', '{}');

insert into public.inbound_events (provider_event_id) values ('evt_compat_1'), ('evt_compat_2');
