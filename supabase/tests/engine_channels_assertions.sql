-- Assertions for 101_engine_channels.sql (owner: Yash). Self-contained; uses its own job.
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
  values ('job_ch', 'CHAN', 'collecting', 'mock', '{}', 500, 'haggle@x.test', 2, now() + interval '1 hour');
-- A phone-only business is valid; its channel must have an address.
insert into public.job_businesses (job_id, business_id, name, email, phone, channel, source, simulated, status)
  values ('job_ch', 'biz_aaaaaaaaaaaaaaaa', 'Mission Eats', null, '+14155550123', 'phone', 'fleet', true, 'ringing');
insert into public.messages (id, job_id, business_id, direction, kind, idempotency_key, channel, parse_status)
  values ('mc1', 'job_ch', 'biz_aaaaaaaaaaaaaaaa', 'out', 'call', 'call:job_ch:biz_aaaaaaaaaaaaaaaa', 'phone', 'none');

select pg_temp.expect_fail('business with no address', $$insert into public.job_businesses (job_id, business_id, name, source, simulated, status) values ('job_ch','biz_bbbbbbbbbbbbbbbb','Nobody','agent',false,'pending')$$);
select pg_temp.expect_fail('email channel without email', $$insert into public.job_businesses (job_id, business_id, name, phone, channel, source, simulated, status) values ('job_ch','biz_cccccccccccccccc','X','+14155550199','email','agent',false,'pending')$$);
select pg_temp.expect_fail('non-E.164 phone', $$insert into public.job_businesses (job_id, business_id, name, phone, channel, source, simulated, status) values ('job_ch','biz_dddddddddddddddd','X','415-555-0100','phone','agent',false,'pending')$$);
select pg_temp.expect_fail('same phone twice on a job', $$insert into public.job_businesses (job_id, business_id, name, phone, channel, source, simulated, status) values ('job_ch','biz_eeeeeeeeeeeeeeee','Y','+14155550123','phone','agent',false,'pending')$$);
select pg_temp.expect_fail('snapshot phone changed', $$update public.job_businesses set phone = '+14155550999' where business_id = 'biz_aaaaaaaaaaaaaaaa'$$);
select pg_temp.expect_fail('unknown business status', $$update public.job_businesses set status = 'won' where business_id = 'biz_aaaaaaaaaaaaaaaa'$$);
select pg_temp.expect_fail('unknown channel', $$update public.messages set channel = 'fax' where id = 'mc1'$$);
select pg_temp.expect_fail('second settings row', $$insert into public.engine_settings (id, spending_cap_cents) values (2, 100)$$);
select pg_temp.expect_fail('zero spending cap', $$insert into public.engine_settings (id, spending_cap_cents) values (1, 0)$$);
select pg_temp.expect_fail('anon reads settings', $$set local role anon; select * from public.engine_settings$$);
reset role;

-- Positive: status updates on a phone business still work; one settings row upserts.
update public.job_businesses set status = 'no_reply' where business_id = 'biz_aaaaaaaaaaaaaaaa';
insert into public.engine_settings (id, spending_cap_cents, default_area) values (1, 120000, 'San Francisco, CA')
  on conflict (id) do update set spending_cap_cents = excluded.spending_cap_cents;
delete from public.jobs where id = 'job_ch';
\echo all channel assertions passed
