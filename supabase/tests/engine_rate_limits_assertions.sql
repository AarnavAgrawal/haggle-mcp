-- Assertions for 124_engine_rate_limits.sql (owner: Aarnav, production hardening item 2).
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

-- max grants, then a refusal with the seconds left in the window; a refused take doesn't count.
do $$
declare r record; i integer;
begin
  for i in 1..3 loop
    select * into r from public.take_rate_slot('rl_assert', 'ws_a', 86400, 3);
    if not r.allowed or r.used <> i or r.retry_after_s <> 0 then raise exception 'take % should be granted with used=%: %', i, i, r; end if;
  end loop;
  for i in 1..2 loop
    select * into r from public.take_rate_slot('rl_assert', 'ws_a', 86400, 3);
    if r.allowed or r.used <> 3 or r.retry_after_s < 1 or r.retry_after_s > 86400 then raise exception 'take over max should be refused with retry_after_s in 1..86400: %', r; end if;
  end loop;
  if (select n from public.rate_limit_slots where bucket = 'rl_assert' and key = 'ws_a') <> 3 then
    raise exception 'refused takes must not count';
  end if;
  -- Different keys and buckets are independent.
  select * into r from public.take_rate_slot('rl_assert', 'ws_b', 86400, 3);
  if not r.allowed or r.used <> 1 then raise exception 'another key must have its own budget: %', r; end if;
  select * into r from public.take_rate_slot('rl_assert_other', 'ws_a', 86400, 3);
  if not r.allowed or r.used <> 1 then raise exception 'another bucket must have its own budget: %', r; end if;
  -- The day window is aligned to UTC midnight.
  if exists (select 1 from public.rate_limit_slots where bucket = 'rl_assert' and window_start <> date_trunc('day', now() at time zone 'utc') at time zone 'utc') then
    raise exception '86400 s windows must start at UTC midnight';
  end if;
end $$;

-- Bad input is refused.
select pg_temp.expect_fail('zero window', $q$select public.take_rate_slot('rl_assert', 'k', 0, 1)$q$);
select pg_temp.expect_fail('negative window', $q$select public.take_rate_slot('rl_assert', 'k', -60, 1)$q$);
select pg_temp.expect_fail('window over a day', $q$select public.take_rate_slot('rl_assert', 'k', 86401, 1)$q$);
select pg_temp.expect_fail('zero max', $q$select public.take_rate_slot('rl_assert', 'k', 60, 0)$q$);
select pg_temp.expect_fail('negative max', $q$select public.take_rate_slot('rl_assert', 'k', 60, -1)$q$);
select pg_temp.expect_fail('null max', $q$select public.take_rate_slot('rl_assert', 'k', 60, null)$q$);
select pg_temp.expect_fail('empty bucket', $q$select public.take_rate_slot('', 'k', 60, 1)$q$);
select pg_temp.expect_fail('empty key', $q$select public.take_rate_slot('rl_assert', '', 60, 1)$q$);
select pg_temp.expect_fail('negative count', $q$insert into public.rate_limit_slots (bucket, key, window_start, n) values ('rl_assert', 'neg', now(), -1)$q$);

-- Privileges: only service_role may execute; anon and authenticated can neither execute nor touch the table.
do $$ begin
  if has_function_privilege('anon', 'public.take_rate_slot(text, text, integer, integer)', 'execute')
     or has_function_privilege('authenticated', 'public.take_rate_slot(text, text, integer, integer)', 'execute') then
    raise exception 'take_rate_slot must not be executable by anon/authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.take_rate_slot(text, text, integer, integer)', 'execute') then
    raise exception 'take_rate_slot must be executable by service_role';
  end if;
  if not (select prosecdef from pg_proc where oid = 'public.take_rate_slot(text, text, integer, integer)'::regprocedure) then
    raise exception 'take_rate_slot must be security definer';
  end if;
  if not exists (select 1 from pg_proc where oid = 'public.take_rate_slot(text, text, integer, integer)'::regprocedure and proconfig @> array['search_path=""']) then
    raise exception 'take_rate_slot must pin an empty search_path';
  end if;
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.rate_limit_slots'::regclass) then
    raise exception 'rate_limit_slots must have forced RLS';
  end if;
  if has_table_privilege('anon', 'public.rate_limit_slots', 'select') or has_table_privilege('anon', 'public.rate_limit_slots', 'insert')
     or has_table_privilege('authenticated', 'public.rate_limit_slots', 'select') or has_table_privilege('authenticated', 'public.rate_limit_slots', 'update') then
    raise exception 'rate_limit_slots must not be readable or writable by anon/authenticated';
  end if;
end $$;

-- And for real: anon is refused at execution; service_role (the web app's RPC) is granted.
do $$
begin
  set local role anon;
  begin
    perform public.take_rate_slot('rl_assert', 'anon', 60, 5);
    raise exception 'NOT REJECTED: anon executed take_rate_slot';
  exception when insufficient_privilege then
    raise notice 'ok (rejected): anon execute';
  end;
  reset role;
  set local role service_role;
  perform public.take_rate_slot('rl_assert', 'service', 60, 5);
  reset role;
  if (select n from public.rate_limit_slots where bucket = 'rl_assert' and key = 'service') <> 1 then
    raise exception 'service_role take not recorded';
  end if;
end $$;
\echo 'engine_rate_limits assertions OK'
