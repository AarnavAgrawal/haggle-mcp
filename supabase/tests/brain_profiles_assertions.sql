-- Assertions for 200_brain_profiles + 201_brain_profiles_grants. Self-contained.
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
reset role;
-- Client roles get nothing (not even TRUNCATE, which RLS doesn't cover).
select pg_temp.expect_fail('anon reads brain_profiles', $$set local role anon; select * from public.brain_profiles$$);
reset role;
select pg_temp.expect_fail('authenticated writes brain_profiles', $$set local role authenticated; insert into public.brain_profiles (business_id, name, category, profile) values ('x','x','x','{}')$$);
reset role;
select pg_temp.expect_fail('anon truncates brain_profiles', $$set local role anon; truncate public.brain_profiles$$);
reset role;
delete from public.brain_profiles where business_id = 'biz_assert_brain';
\echo all brain_profiles assertions passed
