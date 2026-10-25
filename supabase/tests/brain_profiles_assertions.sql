-- Assertions for 200_brain_profiles + 201_brain_profiles_grants + 202_brain_tenancy. Self-contained.
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
-- service_role (the brain's server key) can write and read profiles.
set role service_role;
insert into public.brain_profiles (business_id, name, category, area, profile) values ('biz_assert_brain', 'Assert', 'catering', 'SF', '{}');
update public.brain_profiles set area = 'San Francisco' where business_id = 'biz_assert_brain';
do $$ begin if (select count(*) from public.brain_profiles where business_id = 'biz_assert_brain') <> 1 then raise exception 'service_role cannot read'; end if; end $$;
-- 202: an insert without a workspace (an older writer) lands in the default workspace, never in the
-- reserved pool of pre-tenancy rows (that default applied only to rows that existed when 202 ran;
-- scripts/verify-migrations.sh checks that upgrade path and its re-run on a populated brain database).
do $$ begin if (select workspace_id from public.brain_profiles where business_id = 'biz_assert_brain') <> 'ws_default' then raise exception 'workspace_id did not default to ws_default'; end if; end $$;
do $$ begin
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'brain_profiles' and column_name = 'workspace_id') not like '''ws_default''%' then
    raise exception 'workspace_id column default is not ws_default';
  end if;
end $$;
-- The sentinel is a valid id for the check constraint (pre-tenancy rows must be storable there).
insert into public.brain_profiles (workspace_id, business_id, name, category, profile) values ('ws_legacy_pooled', 'biz_assert_brain', 'Assert', 'catering', '{}');
delete from public.brain_profiles where workspace_id = 'ws_legacy_pooled' and business_id = 'biz_assert_brain';
-- 202: the same business in two workspaces is two rows, each read back by its own workspace.
insert into public.brain_profiles (workspace_id, business_id, name, category, area, profile) values
  ('ws_assert_alpha', 'biz_assert_brain', 'Assert', 'catering', 'SF', '{"typical": 20}'),
  ('ws_assert_beta', 'biz_assert_brain', 'Assert', 'catering', 'SF', '{"typical": 40}');
do $$ begin if (select count(*) from public.brain_profiles where business_id = 'biz_assert_brain') <> 3 then raise exception 'one business should be one row per workspace'; end if; end $$;
do $$ begin if (select profile->>'typical' from public.brain_profiles where workspace_id = 'ws_assert_beta' and business_id = 'biz_assert_brain') <> '40' then raise exception 'workspace row mixed up'; end if; end $$;
-- 202: the brain's upsert (PostgREST on_conflict=workspace_id,business_id) replaces only that workspace's row.
insert into public.brain_profiles (workspace_id, business_id, name, category, area, profile) values ('ws_assert_alpha', 'biz_assert_brain', 'Assert', 'catering', 'SF', '{"typical": 22}')
  on conflict (workspace_id, business_id) do update set profile = excluded.profile;
do $$ begin
  if (select profile->>'typical' from public.brain_profiles where workspace_id = 'ws_assert_alpha' and business_id = 'biz_assert_brain') <> '22' then raise exception 'upsert did not replace alpha''s row'; end if;
  if (select profile->>'typical' from public.brain_profiles where workspace_id = 'ws_assert_beta' and business_id = 'biz_assert_brain') <> '40' then raise exception 'upsert touched beta''s row'; end if;
end $$;
reset role;
-- 202: a duplicate (workspace_id, business_id) and a malformed workspace id are refused; a null workspace too.
select pg_temp.expect_fail('duplicate (workspace_id, business_id)', $$insert into public.brain_profiles (workspace_id, business_id, name, category, profile) values ('ws_assert_alpha', 'biz_assert_brain', 'x', 'x', '{}')$$);
select pg_temp.expect_fail('malformed workspace_id', $$insert into public.brain_profiles (workspace_id, business_id, name, category, profile) values ('Acme Inc', 'biz_assert_bad', 'x', 'x', '{}')$$);
select pg_temp.expect_fail('null workspace_id', $$insert into public.brain_profiles (workspace_id, business_id, name, category, profile) values (null, 'biz_assert_null', 'x', 'x', '{}')$$);
-- 202: the key and index are the per-workspace ones (no FK to workspaces: the brain applies before 103 on some paths).
do $$ begin
  if (select array_agg(a.attname::text order by k.ord) from pg_constraint c cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum where c.conrelid = 'public.brain_profiles'::regclass and c.contype = 'p') is distinct from array['workspace_id', 'business_id'] then
    raise exception 'brain_profiles primary key is not (workspace_id, business_id)';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.brain_profiles'::regclass and contype = 'f') then raise exception 'brain_profiles must not have a foreign key'; end if;
  if to_regclass('public.brain_profiles_workspace_category_area_idx') is null then raise exception 'missing (workspace_id, category, area) index'; end if;
  if to_regclass('public.brain_profiles_category_area_idx') is not null then raise exception 'old (category, area) index still there'; end if;
end $$;
-- Client roles get nothing (not even TRUNCATE, which RLS doesn't cover), workspace_id included.
select pg_temp.expect_fail('anon reads brain_profiles', $$set local role anon; select * from public.brain_profiles$$);
reset role;
select pg_temp.expect_fail('authenticated reads brain_profiles.workspace_id', $$set local role authenticated; select workspace_id from public.brain_profiles$$);
reset role;
select pg_temp.expect_fail('authenticated writes brain_profiles', $$set local role authenticated; insert into public.brain_profiles (business_id, name, category, profile) values ('x','x','x','{}')$$);
reset role;
select pg_temp.expect_fail('anon truncates brain_profiles', $$set local role anon; truncate public.brain_profiles$$);
reset role;
delete from public.brain_profiles where business_id = 'biz_assert_brain';
\echo all brain_profiles assertions passed
