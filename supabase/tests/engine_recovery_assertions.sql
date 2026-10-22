-- Assertions for 117_engine_ops.sql (owner: Yash; sprint 4 workstream F). Self-contained.
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

-- Reconciler high-water marks: one per (scope, channel), known channels only, never moved back by the upsert the engine uses.
insert into public.reconcile_cursors (scope, channel, high_water) values ('assert@inkboxmail.test', 'email', '2026-10-20T00:00:00Z');
select pg_temp.expect_fail('unknown channel', $$insert into public.reconcile_cursors (scope, channel, high_water) values ('assert@inkboxmail.test', 'fax', now())$$);
select pg_temp.expect_fail('duplicate (scope, channel)', $$insert into public.reconcile_cursors (scope, channel, high_water) values ('assert@inkboxmail.test', 'email', now())$$);
select pg_temp.expect_fail('empty scope', $$insert into public.reconcile_cursors (scope, channel, high_water) values ('', 'text', now())$$);
insert into public.reconcile_cursors (scope, channel, high_water) values ('assert@inkboxmail.test', 'email', '2026-10-18T00:00:00Z')
  on conflict (scope, channel) do update set high_water = greatest(reconcile_cursors.high_water, excluded.high_water), updated_at = now();
do $$ begin
  if (select high_water from public.reconcile_cursors where scope = 'assert@inkboxmail.test' and channel = 'email') <> '2026-10-20T00:00:00Z'::timestamptz then
    raise exception 'the high-water mark moved back';
  end if;
end $$;

-- Clients never see it: RLS forced, no grants to anon/authenticated.
do $$ begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.reconcile_cursors'::regclass) then
    raise exception 'reconcile_cursors must force row level security';
  end if;
  if has_table_privilege('anon', 'public.reconcile_cursors', 'select') or has_table_privilege('authenticated', 'public.reconcile_cursors', 'select') then
    raise exception 'reconcile_cursors is readable by a client role';
  end if;
end $$;

-- The read-path indexes exist (query plans: packages/engine/tests/queryPlans.pg.test.ts).
do $$
declare i text;
begin
  foreach i in array array['jobs_open_created_idx', 'job_businesses_rfq_msgid_idx', 'messages_quarantined_idx', 'approvals_pending_channel_idx'] loop
    if to_regclass('public.' || i) is null then raise exception 'missing index %', i; end if;
  end loop;
end $$;

delete from public.reconcile_cursors where scope = 'assert@inkboxmail.test';
\echo 'all recovery assertions passed'
