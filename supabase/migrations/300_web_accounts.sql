-- 300_web_accounts: which Haggle workspace each web app user belongs to (apps/web).
-- A user signs in with Supabase Auth; onboarding asks the MCP server to create their workspace
-- (POST /internal/workspaces) and the web backend records the membership with the service role.
-- Users read only their own memberships; nobody writes them except the service role.
-- Safe to re-run (idempotent: if-not-exists and guarded policy/foreign key).
--
-- The link to auth.users and the row-level-security policy need Supabase's auth schema; on a plain
-- Postgres (scripts/verify-migrations.sh) the table is created without them.

create table if not exists public.workspace_members (
  user_id      uuid not null,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  role         text not null default 'owner' check (role in ('owner', 'member')),
  created_at   timestamptz not null default now(),
  primary key (user_id, workspace_id)
);
create index if not exists workspace_members_workspace_idx on public.workspace_members (workspace_id);
alter table public.workspace_members enable row level security;

do $$
begin
  if to_regclass('auth.users') is not null then
    if not exists (select 1 from pg_constraint where conname = 'workspace_members_user_fk') then
      alter table public.workspace_members
        add constraint workspace_members_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_members' and policyname = 'members read their own memberships') then
      execute 'create policy "members read their own memberships" on public.workspace_members for select to authenticated using (user_id = auth.uid())';
    end if;
  end if;
end $$;
