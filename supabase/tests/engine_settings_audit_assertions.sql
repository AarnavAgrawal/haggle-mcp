-- Assertions for 129_engine_settings_audit.sql (owner: Aarnav). Self-contained; uses its own workspace.
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

insert into public.workspaces (id, name, spending_cap_cents) values ('ws_audit_t', 'Audit test', 150000);
update public.workspaces set sender_name = 'Priya at Acme Labs' where id = 'ws_audit_t';
select pg_temp.expect_fail('blank sender name', $$update public.workspaces set sender_name = '  ' where id = 'ws_audit_t'$$);

insert into public.settings_audit (workspace_id, by, actor, field, old_value, new_value)
  values ('ws_audit_t', 'owner', 'priya@acme.test (u1)', 'spending_cap_cents', '150000', '300000');
select pg_temp.expect_fail('unknown actor kind', $$insert into public.settings_audit (workspace_id, by, field) values ('ws_audit_t', 'model', 'name')$$);
select pg_temp.expect_fail('audit row updated', $$update public.settings_audit set new_value = '1' where workspace_id = 'ws_audit_t'$$);
select pg_temp.expect_fail('audit row deleted', $$delete from public.settings_audit where workspace_id = 'ws_audit_t'$$);
select pg_temp.expect_fail('anon reads audit', $$set local role anon; select * from public.settings_audit$$);

insert into public.approver_changes (id, workspace_id, kind, value, code_hash, requested_by, expires_at)
  values ('apc_t1', 'ws_audit_t', 'phone', '+14155550123', repeat('a', 64), 'priya', now() + interval '15 minutes');
update public.approver_changes set attempts = 1 where id = 'apc_t1';
select pg_temp.expect_fail('non-E.164 pending phone', $$insert into public.approver_changes (id, workspace_id, kind, value, code_hash, requested_by, expires_at) values ('apc_t2', 'ws_audit_t', 'phone', '415-555', repeat('a', 64), 'p', now())$$);
select pg_temp.expect_fail('uppercase pending email', $$insert into public.approver_changes (id, workspace_id, kind, value, code_hash, requested_by, expires_at) values ('apc_t3', 'ws_audit_t', 'email', 'A@B.TEST', repeat('a', 64), 'p', now())$$);
select pg_temp.expect_fail('plain code stored', $$insert into public.approver_changes (id, workspace_id, kind, value, code_hash, requested_by, expires_at) values ('apc_t4', 'ws_audit_t', 'phone', '+14155550124', '123456', 'p', now())$$);
select pg_temp.expect_fail('unknown status', $$update public.approver_changes set status = 'done' where id = 'apc_t1'$$);
select pg_temp.expect_fail('anon reads pending changes', $$set local role anon; select * from public.approver_changes$$);

delete from public.approver_changes where workspace_id = 'ws_audit_t';
-- settings_audit is append-only, so the workspace (no foreign key from the audit) is removed alone.
delete from public.workspaces where id = 'ws_audit_t';
