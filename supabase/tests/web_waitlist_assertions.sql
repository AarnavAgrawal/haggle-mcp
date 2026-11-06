-- Assertions for 303_web_waitlist.sql: a row is what grants access, so it must be closed to everyone but the
-- service role, and its checks must hold even if the web app's validation is bypassed.
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

insert into public.web_waitlist (email, full_name, organization) values ('assert@example.com', 'Ada', 'Engines');

select pg_temp.expect_fail('duplicate email', $q$insert into public.web_waitlist (email, full_name, organization) values ('assert@example.com', 'Other', 'Org')$q$);
select pg_temp.expect_fail('uppercase email', $q$insert into public.web_waitlist (email, full_name, organization) values ('Assert2@example.com', 'Ada', 'Engines')$q$);
select pg_temp.expect_fail('empty name', $q$insert into public.web_waitlist (email, full_name, organization) values ('a3@example.com', '', 'Engines')$q$);
select pg_temp.expect_fail('missing organization', $q$insert into public.web_waitlist (email, full_name) values ('a4@example.com', 'Ada')$q$);
select pg_temp.expect_fail('over-long use case', $q$insert into public.web_waitlist (email, full_name, organization, use_case) values ('a5@example.com', 'Ada', 'Engines', repeat('x', 501))$q$);
select pg_temp.expect_fail('admitted with nobody recorded', $q$update public.web_waitlist set admitted_at = now() where email = 'assert@example.com'$q$);
select pg_temp.expect_fail('notified before admitted', $q$update public.web_waitlist set notified_at = now() where email = 'assert@example.com'$q$);

-- Neither public role can read, add or admit.
set role anon;
select pg_temp.expect_fail('anon reads', $q$select * from public.web_waitlist$q$);
select pg_temp.expect_fail('anon inserts', $q$insert into public.web_waitlist (email, full_name, organization) values ('a6@example.com', 'Ada', 'Engines')$q$);
reset role;
set role authenticated;
select pg_temp.expect_fail('authenticated reads', $q$select * from public.web_waitlist$q$);
select pg_temp.expect_fail('authenticated admits', $q$update public.web_waitlist set admitted_at = now(), admitted_by = 'me'$q$);
reset role;

-- The service role does everything the web app and the operator's script need.
set role service_role;
do $$
begin
  if (select count(*) from public.web_waitlist where email = 'assert@example.com') <> 1 then raise exception 'service_role must read the waitlist'; end if;
  update public.web_waitlist set admitted_at = now(), admitted_by = 'assert', notified_at = now() where email = 'assert@example.com';
  delete from public.web_waitlist where email = 'assert@example.com';
end $$;
reset role;
