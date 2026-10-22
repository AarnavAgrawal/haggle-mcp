-- After seed_at_102.sql and every later migration: the demo-era rows survived intact, moved to the
-- default workspace (103), and the safety triggers added since hold on them (115: a settled payment
-- is final). Only facts every later migration must preserve; no assumption about new tables.
do $$
declare n integer;
begin
  select count(*) into n from public.jobs where id like 'job_compat_%';
  if n <> 4 then raise exception 'compat: expected 4 seeded jobs, found %', n; end if;
  select count(*) into n from public.jobs where id like 'job_compat_%' and workspace_id = 'ws_default';
  if n <> 4 then raise exception 'compat: seeded jobs must be in ws_default after 103, found %', n; end if;
  if not exists (select 1 from public.workspaces where id = 'ws_default' and spending_cap_cents = 150000 and approver_phone = '+14155550123') then
    raise exception 'compat: ws_default must carry engine_settings (103)';
  end if;
  if (select state from public.jobs where id = 'job_compat_paid') <> 'paid' or (select state from public.jobs where id = 'job_compat_open') <> 'collecting' then
    raise exception 'compat: job states changed';
  end if;
  select count(*) into n from public.job_businesses where job_id like 'job_compat_%';
  if n <> 5 then raise exception 'compat: expected 5 job_businesses, found %', n; end if;
  select count(*) into n from public.messages where job_id like 'job_compat_%';
  if n <> 5 then raise exception 'compat: expected 5 messages, found %', n; end if;
  if (select total_cents from public.quotes where id = 'q_compat_1') <> 60000 or (select deposit_cents from public.quotes where id = 'q_compat_1') <> 15000 then
    raise exception 'compat: the quote''s amounts changed';
  end if;
  if (select status from public.approvals where id = 'ap_compat_1') <> 'used' or (select payment_cents from public.approvals where id = 'ap_compat_1') <> 15000 then
    raise exception 'compat: the approval changed';
  end if;
  if (select status from public.payments where id = 'pay_compat_1') <> 'settled' or (select stripe_payment_intent_id from public.payments where id = 'pay_compat_1') <> 'pi_compat1' then
    raise exception 'compat: the settled payment changed';
  end if;
  if (select count(*) from public.job_events where job_id = 'job_compat_paid') <> 3 then raise exception 'compat: job events lost'; end if;
  if (select status from public.questions where id = 'qn_compat_1') <> 'pending' then raise exception 'compat: the open question changed'; end if;
end $$;

-- 115: a settled payment is final, also for rows written before 115 existed.
do $$
begin
  begin
    update public.payments set status = 'failed' where id = 'pay_compat_1';
  exception when others then
    return;
  end;
  raise exception 'compat: a settled pre-115 payment could still be changed';
end $$;

-- The open deal can still be worked on by current code: a new event appends after the old ones.
do $$
begin
  if public.haggle_append_event('job_compat_open', 'compat_check', '{}') <> 2 then raise exception 'compat: event sequence broken'; end if;
end $$;
