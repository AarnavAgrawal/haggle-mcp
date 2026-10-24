-- Assertions for 111_engine_ops.sql (owner: Yash). Self-contained.
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

-- The ledger records itself, without a checksum until an operator runs `migrations.ts record`.
do $$ begin
  if not exists (select 1 from public.engine_migrations where name = '111_engine_ops.sql' and checksum is null) then
    raise exception 'engine_migrations does not record 111 itself';
  end if;
end $$;

select pg_temp.expect_fail('ledger name not a migration file', $$insert into public.engine_migrations (name) values ('drop table jobs')$$);
select pg_temp.expect_fail('ledger checksum not sha-256 hex', $$insert into public.engine_migrations (name, checksum) values ('100_engine_core.sql', 'abc')$$);
insert into public.engine_migrations (name, checksum, recorded_by) values ('100_engine_core.sql', repeat('a', 64), 'assertions');
select pg_temp.expect_fail('duplicate ledger row', $$insert into public.engine_migrations (name, checksum) values ('100_engine_core.sql', repeat('b', 64))$$);

-- Clients never see it: RLS forced, no grants to anon/authenticated.
do $$ begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.engine_migrations'::regclass) then
    raise exception 'engine_migrations must force row level security';
  end if;
  if has_table_privilege('anon', 'public.engine_migrations', 'select') or has_table_privilege('authenticated', 'public.engine_migrations', 'select') then
    raise exception 'engine_migrations is readable by a client role';
  end if;
end $$;

delete from public.engine_migrations where recorded_by = 'assertions';
\echo 'all ops assertions passed'
