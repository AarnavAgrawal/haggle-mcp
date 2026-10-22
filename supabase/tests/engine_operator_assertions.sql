-- Assertions for 119_engine_pilot.sql (owner: Yash): the operator log is append-only and constrained.
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

insert into public.operator_actions (id, workspace_id, action, operator, reason, detail)
  values ('opa_assert1', 'ws_assert', 'workspace_suspended', 'ops-yash', 'customer asked to pause', '{}');
insert into public.operator_actions (id, action, operator, reason, detail)
  values ('opa_assert2', 'suppression_removed', 'ops-yash', 'mailbox was full', '{"contact":"x@y.example"}');

select pg_temp.expect_fail('update', $$update public.operator_actions set reason = 'rewritten' where id = 'opa_assert1'$$);
select pg_temp.expect_fail('delete', $$delete from public.operator_actions where id = 'opa_assert1'$$);
select pg_temp.expect_fail('unknown action', $$insert into public.operator_actions (id, workspace_id, action, operator, reason) values ('opa_a3','ws_assert','approve_payment','ops','not an operator action')$$);
select pg_temp.expect_fail('operator too short', $$insert into public.operator_actions (id, workspace_id, action, operator, reason) values ('opa_a4','ws_assert','cap_changed',' x ','budget limit')$$);
select pg_temp.expect_fail('reason too short', $$insert into public.operator_actions (id, workspace_id, action, operator, reason) values ('opa_a5','ws_assert','cap_changed','ops','no')$$);
select pg_temp.expect_fail('no subject', $$insert into public.operator_actions (id, action, operator, reason) values ('opa_a6','vendor_added','ops','consent text here')$$);
select pg_temp.expect_fail('detail not an object', $$insert into public.operator_actions (id, workspace_id, action, operator, reason, detail) values ('opa_a7','ws_assert','cap_changed','ops','budget limit','[1,2]')$$);
select pg_temp.expect_fail('seq set by hand', $$insert into public.operator_actions (id, workspace_id, action, operator, reason, seq) values ('opa_a8','ws_assert','cap_changed','ops','budget limit', 1)$$);

do $$
begin
  if (select count(*) from public.operator_actions where id like 'opa_assert%') <> 2 then raise exception 'operator_actions rows changed'; end if;
  if (select seq from public.operator_actions where id = 'opa_assert1') >= (select seq from public.operator_actions where id = 'opa_assert2') then raise exception 'seq not in insertion order'; end if;
end $$;
