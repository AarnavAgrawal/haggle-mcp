-- 119_engine_pilot (owner: Yash). Pilot operations (sprint 5, workstream B): one append-only audit
-- log of operator actions taken from the scripts (never from an MCP tool).
--   * operator_actions: who did what to which workspace / job, why, and when. Each row is final
--     (no update, no delete). It also carries state that must stay auditable:
--       - workspace suspension: the latest workspace_suspended / workspace_resumed row decides;
--       - approver verification: approver_verified for one phone number (a later approver change or
--         approver_unverified supersedes it);
--       - roster changes: vendor_added / vendor_removed with the consent text they rest on.
-- No foreign keys: the log outlives what it names (like quarantine_resolutions, migration 112).
-- Additive only: no existing check, trigger or policy is relaxed; nothing depends on 112-118. Safe to re-run.

create table if not exists public.operator_actions (
  id           text primary key check (length(id) between 1 and 100),
  workspace_id text check (workspace_id is null or length(workspace_id) between 1 and 64),
  job_id       text check (job_id is null or length(job_id) between 1 and 64),
  action       text not null check (action in (
                 'workspace_created','workspace_suspended','workspace_resumed','credentials_revoked','credentials_rotated',
                 'approver_changed','approver_verified','approver_unverified','cap_changed',
                 'vendor_added','vendor_removed','suppression_removed',
                 'text_release_requested','callback_requested','job_held','job_resumed','job_close_requested',
                 'retry_requested','review_resolved')),
  operator     text not null check (length(btrim(operator)) between 2 and 80),
  reason       text not null check (length(btrim(reason)) between 3 and 500),
  detail       jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 4000),
  at           timestamptz not null default now(),
  -- Insertion order (the latest suspension / verification row decides, even within one millisecond).
  seq          bigint generated always as identity unique,
  check (workspace_id is not null or job_id is not null or action = 'suppression_removed')
);
create index if not exists operator_actions_workspace_idx on public.operator_actions(workspace_id, at desc);
create index if not exists operator_actions_job_idx on public.operator_actions(job_id, at desc) where job_id is not null;

create or replace function public.haggle_operator_actions_append_only() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'operator_actions is append-only';
end;
$$;
drop trigger if exists operator_actions_append_only on public.operator_actions;
create trigger operator_actions_append_only before update or delete on public.operator_actions
  for each row execute function public.haggle_operator_actions_append_only();
revoke execute on function public.haggle_operator_actions_append_only() from public, anon, authenticated;

alter table public.operator_actions enable row level security;
alter table public.operator_actions force row level security;
revoke all on public.operator_actions from anon, authenticated;
