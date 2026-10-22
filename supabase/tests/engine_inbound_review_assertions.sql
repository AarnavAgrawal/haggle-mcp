-- Assertions for 112_engine_inbound_review.sql (owner: Yash). Self-contained; cleans up after itself.
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
  values ('job_ir_assert', 'IRAS', 'collecting', 'live', '{}', 50000, 'haggle@x.test', 2, now() + interval '1 hour');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, idempotency_key, parse_status, channel)
  values ('msg_ir_out', 'job_ir_assert', 'biz_ir', 'out', 'rfq', 'prov_ir_out', 'rfq:job_ir_assert:biz_ir', 'none', 'email');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status, sender_trusted, trust_reason, quarantine_reason, from_address, body_text)
  values ('msg_ir_q', 'job_ir_assert', 'biz_ir', 'in', 'quarantine', 'prov_ir_q', 'none', false, 'unverified-external-sender', 'identity_unverified:token_missing', 'v@vendor.example', '$1,150 total');
insert into public.messages (id, job_id, business_id, direction, kind, provider_email_id, parse_status, sender_trusted, trust_reason, quarantine_reason)
  values ('msg_ir_q2', 'job_ir_assert', 'biz_ir', 'in', 'quarantine', 'prov_ir_q2', 'none', false, null, 'sender_mismatch');

-- Delivery status only on our own outbound email, with a time.
update public.messages set delivery_status = 'bounced', delivery_status_at = now() where id = 'msg_ir_out';
select pg_temp.expect_fail('delivery status on an inbound message', $$update public.messages set delivery_status = 'failed', delivery_status_at = now() where id = 'msg_ir_q'$$);
select pg_temp.expect_fail('delivery status without a time', $$update public.messages set delivery_status = 'failed', delivery_status_at = null where id = 'msg_ir_out'$$);
select pg_temp.expect_fail('unknown delivery status', $$update public.messages set delivery_status = 'delivered' where id = 'msg_ir_out'$$);

-- No release without a recorded resolution; never as anything but operator_verified; the reason stays.
select pg_temp.expect_fail('release without a resolution', $$update public.messages set kind = 'reply', sender_trusted = true, trust_reason = 'operator_verified', parse_status = 'pending' where id = 'msg_ir_q'$$);
select pg_temp.expect_fail('trusting an untrusted message without a resolution', $$update public.messages set sender_trusted = true, trust_reason = 'trusted' where id = 'msg_ir_q2'$$);
select pg_temp.expect_fail('a quarantined message turned into an untrusted reply', $$update public.messages set kind = 'reply' where id = 'msg_ir_q'$$);

select pg_temp.expect_fail('released without verification text', $$insert into public.quarantine_resolutions (id, message_id, job_id, business_id, decision, original_reason, resolved_by, verification, released_trust_reason) values ('qr_bad1', 'msg_ir_q', 'job_ir_assert', 'biz_ir', 'released', 'x', 'ops', 'ok', 'operator_verified')$$);
select pg_temp.expect_fail('released with another trust reason', $$insert into public.quarantine_resolutions (id, message_id, job_id, business_id, decision, original_reason, resolved_by, verification, released_trust_reason) values ('qr_bad2', 'msg_ir_q', 'job_ir_assert', 'biz_ir', 'released', 'x', 'ops', 'phoned the vendor at its listed number', 'trusted')$$);
select pg_temp.expect_fail('released without a job and business', $$insert into public.quarantine_resolutions (id, message_id, decision, original_reason, resolved_by, verification, released_trust_reason) values ('qr_bad3', 'msg_ir_q', 'released', 'x', 'ops', 'phoned the vendor at its listed number', 'operator_verified')$$);

insert into public.quarantine_resolutions (id, message_id, job_id, business_id, decision, original_reason, original_trust_reason, resolved_by, verification, released_trust_reason)
  values ('qr_ir_1', 'msg_ir_q', 'job_ir_assert', 'biz_ir', 'released', 'identity_unverified:token_missing', 'unverified-external-sender', 'Ops Person', 'phoned the vendor at its listed number', 'operator_verified');
select pg_temp.expect_fail('a second decision for the same message', $$insert into public.quarantine_resolutions (id, message_id, job_id, business_id, decision, original_reason, resolved_by, verification) values ('qr_ir_2', 'msg_ir_q', 'job_ir_assert', 'biz_ir', 'rejected', 'x', 'ops', 'looked spoofed to me')$$);
select pg_temp.expect_fail('resolutions are append-only (update)', $$update public.quarantine_resolutions set resolved_by = 'someone else' where id = 'qr_ir_1'$$);
select pg_temp.expect_fail('resolutions are append-only (delete)', $$delete from public.quarantine_resolutions where id = 'qr_ir_1'$$);

select pg_temp.expect_fail('release as another trust reason', $$update public.messages set kind = 'reply', sender_trusted = true, trust_reason = 'trusted', parse_status = 'pending' where id = 'msg_ir_q'$$);
select pg_temp.expect_fail('release that drops the quarantine reason', $$update public.messages set kind = 'reply', sender_trusted = true, trust_reason = 'operator_verified', parse_status = 'pending', quarantine_reason = null where id = 'msg_ir_q'$$);
select pg_temp.expect_fail('release onto another business', $$update public.messages set kind = 'reply', sender_trusted = true, trust_reason = 'operator_verified', parse_status = 'pending', business_id = 'biz_other' where id = 'msg_ir_q'$$);
update public.messages set kind = 'reply', sender_trusted = true, trust_reason = 'operator_verified', parse_status = 'pending' where id = 'msg_ir_q';

-- A rejection is recorded without a trust change.
insert into public.quarantine_resolutions (id, message_id, job_id, business_id, decision, original_reason, resolved_by, verification)
  values ('qr_ir_3', 'msg_ir_q2', 'job_ir_assert', 'biz_ir', 'rejected', 'sender_mismatch', 'Ops Person', 'vendor says it never sent this');
select pg_temp.expect_fail('rejected then trusted', $$update public.messages set sender_trusted = true, trust_reason = 'operator_verified' where id = 'msg_ir_q2'$$);

-- Clients never see it: RLS forced, no grants to anon/authenticated.
do $$ begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.quarantine_resolutions'::regclass) then
    raise exception 'quarantine_resolutions must force row level security';
  end if;
  if has_table_privilege('anon', 'public.quarantine_resolutions', 'select') or has_table_privilege('authenticated', 'public.quarantine_resolutions', 'select') then
    raise exception 'quarantine_resolutions is readable by a client role';
  end if;
end $$;

-- Clean up (resolutions are append-only: the trigger is bypassed only for this test's own rows).
alter table public.quarantine_resolutions disable trigger quarantine_resolutions_append_only;
delete from public.quarantine_resolutions where id like 'qr_ir_%';
alter table public.quarantine_resolutions enable trigger quarantine_resolutions_append_only;
delete from public.jobs where id = 'job_ir_assert';
delete from public.messages where id like 'msg_ir_%';
\echo 'all inbound review assertions passed'
