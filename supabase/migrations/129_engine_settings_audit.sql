-- 129_engine_settings_audit (owner: Aarnav). The signed-in workspace owner changes settings in the web
-- app (POST /internal/workspaces/settings). Before this only the operator's scripts could.
--   * workspaces.sender_name: the From name businesses see on Haggle's email for this workspace
--     (e.g. "Priya at Acme Labs"). Null = not set (the workspace name is used).
--   * settings_audit: one row per changed setting, append-only: who (by = operator | agent | owner,
--     plus the actor), when, which field, and the old and new values. Phone numbers and emails are
--     stored masked, never in full.
--   * approver_changes: a new approver phone or email waits here until it is verified (a 6-digit code
--     by iMessage, or a confirm link by email). Until then the old approver stays. Only hashes of the
--     code and the link token are stored. A newer request for the same kind supersedes an older one.
-- RLS on, no client policies: only the server (service_role) reads or writes.
-- Additive only (new nullable column, new tables); no existing check, trigger or policy changes. Safe to re-run.

alter table public.workspaces add column if not exists sender_name text
  check (sender_name is null or length(btrim(sender_name)) between 1 and 80);

create table if not exists public.settings_audit (
  id           bigint generated always as identity primary key,
  workspace_id text not null check (length(workspace_id) between 1 and 64),
  by           text not null check (by in ('operator', 'agent', 'owner')),
  actor        text check (actor is null or length(actor) <= 200),
  field        text not null check (field ~ '^[a-z_]{2,40}$'),
  old_value    text check (old_value is null or length(old_value) <= 300),
  new_value    text check (new_value is null or length(new_value) <= 300),
  at           timestamptz not null default now()
);
create index if not exists settings_audit_workspace_idx on public.settings_audit(workspace_id, at desc);

create or replace function public.haggle_settings_audit_append_only() returns trigger
  language plpgsql set search_path = pg_catalog, public as $$
begin
  raise exception 'settings_audit is append-only';
end;
$$;
drop trigger if exists settings_audit_append_only on public.settings_audit;
create trigger settings_audit_append_only before update or delete on public.settings_audit
  for each row execute function public.haggle_settings_audit_append_only();
revoke execute on function public.haggle_settings_audit_append_only() from public, anon, authenticated;

alter table public.settings_audit enable row level security;
alter table public.settings_audit force row level security;
revoke all on public.settings_audit from anon, authenticated;

create table if not exists public.approver_changes (
  id           text primary key check (length(id) between 1 and 100),
  workspace_id text not null references public.workspaces(id) on delete cascade,
  kind         text not null check (kind in ('phone', 'email')),
  value        text not null check (
                 (kind = 'phone' and value ~ '^\+[1-9][0-9]{6,14}$')
                 or (kind = 'email' and value = lower(value) and length(value) between 3 and 254)),
  code_hash    text not null check (code_hash ~ '^[0-9a-f]{64}$'),
  token_hash   text check (token_hash is null or token_hash ~ '^[0-9a-f]{64}$'),
  attempts     integer not null default 0 check (attempts >= 0),
  status       text not null default 'pending' check (status in ('pending', 'confirmed', 'superseded', 'expired', 'failed')),
  requested_by text not null check (length(requested_by) between 1 and 200),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  decided_at   timestamptz
);
create index if not exists approver_changes_pending_idx on public.approver_changes(workspace_id, kind) where status = 'pending';
create unique index if not exists approver_changes_token_idx on public.approver_changes(token_hash) where token_hash is not null;

alter table public.approver_changes enable row level security;
alter table public.approver_changes force row level security;
revoke all on public.approver_changes from anon, authenticated;
