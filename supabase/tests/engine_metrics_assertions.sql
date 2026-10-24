-- Assertions for 122_engine_metrics.sql (owner: Yash, sprint 5 workstream E).
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

insert into public.ai_usage_events (job_id, workspace_id, purpose, model, input_tokens, output_tokens, cache_read_input_tokens)
  values ('job_mx_assert', 'ws_mx_assert', 'extract', 'claude-sonnet-5-5', 1200, 300, 50);
-- A usage row for a job that doesn't exist (or no job at all) is accepted: recording must never fail the call.
insert into public.ai_usage_events (job_id, purpose, model) values (null, 'answer_question', 'claude-sonnet-5-5');
do $$ begin
  if (select count(*) from public.ai_usage_events where job_id = 'job_mx_assert' and input_tokens = 1200 and output_tokens = 300 and cache_creation_input_tokens = 0 and cache_read_input_tokens = 50) <> 1 then
    raise exception 'ai_usage_events row not stored as given';
  end if;
end $$;
select pg_temp.expect_fail('negative tokens', $q$insert into public.ai_usage_events (purpose, model, input_tokens) values ('extract', 'claude-sonnet-5-5', -1)$q$);
select pg_temp.expect_fail('empty model', $q$insert into public.ai_usage_events (purpose, model) values ('extract', '')$q$);
select pg_temp.expect_fail('update', $q$update public.ai_usage_events set output_tokens = 0 where job_id = 'job_mx_assert'$q$);
select pg_temp.expect_fail('delete', $q$delete from public.ai_usage_events where job_id = 'job_mx_assert'$q$);
do $$ begin
  if not (select relrowsecurity and relforcerowsecurity from pg_class where oid = 'public.ai_usage_events'::regclass) then
    raise exception 'ai_usage_events must have forced RLS';
  end if;
  if has_table_privilege('anon', 'public.ai_usage_events', 'select') or has_table_privilege('authenticated', 'public.ai_usage_events', 'insert') then
    raise exception 'ai_usage_events must not be readable or writable by anon/authenticated';
  end if;
end $$;
\echo 'engine_metrics assertions OK'
