-- 124_engine_rate_limits (owner: Aarnav, production hardening item 2). Rate limits shared by every
-- process on this database, instead of a count in each process's memory.
--   * rate_limit_slots: one counter per (bucket, key, fixed window). Windows are aligned to the epoch,
--     so a 86400 s window is exactly the UTC day.
--   * take_rate_slot(bucket, key, window_s, max): takes one slot in the current window, atomically (a
--     single upsert: concurrent takes from any number of processes never grant more than max). A refused
--     take doesn't count. Returns (allowed, used, retry_after_s). Windows of 1..86400 s only, so rows
--     older than two days are always finished; about 1 take in 100 also deletes up to 500 of them.
-- Callers: the MCP server (PostgresRepository.takeRateSlot: vendor additions per workspace per day) and
-- the web app (supabase.rpc as service_role: chat, approval, vendor and account limits).
-- SECURITY DEFINER with an empty search_path (every name qualified); executable by service_role only,
-- never by anon or authenticated, and the table is closed to both.
-- Additive only; depends on nothing after 100. Applies alone on top of 100-117. Safe to re-run.

create table if not exists public.rate_limit_slots (
  bucket       text not null check (length(bucket) between 1 and 64),
  key          text not null check (length(key) between 1 and 200),
  window_start timestamptz not null,
  n            integer not null default 0 check (n >= 0),
  primary key (bucket, key, window_start)
);
create index if not exists rate_limit_slots_window_idx on public.rate_limit_slots (window_start);

alter table public.rate_limit_slots enable row level security;
alter table public.rate_limit_slots force row level security;
revoke all on public.rate_limit_slots from anon, authenticated;

create or replace function public.take_rate_slot(p_bucket text, p_key text, p_window_s integer, p_max integer)
returns table (allowed boolean, used integer, retry_after_s integer)
language plpgsql security definer set search_path = '' as $$
declare
  ws  timestamptz;
  cur integer;
begin
  if p_bucket is null or length(p_bucket) not between 1 and 64 then
    raise exception 'take_rate_slot: bucket must be 1-64 characters' using errcode = '22023';
  end if;
  if p_key is null or length(p_key) not between 1 and 200 then
    raise exception 'take_rate_slot: key must be 1-200 characters' using errcode = '22023';
  end if;
  if p_window_s is null or p_window_s <= 0 or p_window_s > 86400 then
    raise exception 'take_rate_slot: window must be 1-86400 seconds' using errcode = '22023';
  end if;
  if p_max is null or p_max <= 0 then
    raise exception 'take_rate_slot: max must be positive' using errcode = '22023';
  end if;

  ws := pg_catalog.to_timestamp(pg_catalog.floor(extract(epoch from pg_catalog.now()) / p_window_s) * p_window_s);

  -- Housekeeping, rarely and without waiting on anyone: finished windows only (every window is at most a day).
  if pg_catalog.random() < 0.01 then
    delete from public.rate_limit_slots d
    where (d.bucket, d.key, d.window_start) in (
      select o.bucket, o.key, o.window_start from public.rate_limit_slots o
      where o.window_start < pg_catalog.now() - interval '2 days'
      limit 500 for update skip locked);
  end if;

  -- The take: insert the window's first slot, or add one while under max. The conflicting row is locked
  -- and the WHERE re-checked on its latest version, so concurrent takes serialize on it.
  insert into public.rate_limit_slots as s (bucket, key, window_start, n)
  values (p_bucket, p_key, ws, 1)
  on conflict (bucket, key, window_start) do update set n = s.n + 1
    where s.n < p_max
  returning s.n into cur;

  if cur is null then
    select s.n into cur from public.rate_limit_slots s
    where s.bucket = p_bucket and s.key = p_key and s.window_start = ws;
    return query select false, coalesce(cur, p_max),
      greatest(1, pg_catalog.ceil(extract(epoch from (ws + pg_catalog.make_interval(secs => p_window_s) - pg_catalog.now())))::integer);
  else
    return query select true, cur, 0;
  end if;
end;
$$;
revoke all on function public.take_rate_slot(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.take_rate_slot(text, text, integer, integer) to service_role;
