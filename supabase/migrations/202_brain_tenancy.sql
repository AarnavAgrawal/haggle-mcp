-- 202_brain_tenancy (Brain, Aarnav): learned business profiles belong to one workspace.
-- brain_profiles was one row per business shared by every workspace, so `ask`, `check_price`, the
-- board's price check and business_profile mixed customers' data. Each row now carries its
-- workspace and is keyed (workspace_id, business_id); packages/brain SupabaseStore filters every
-- read and write by it (one brain per workspace: createWorkspaceBrains).
--   * Existing rows were learned from EVERY workspace's deals, so they belong to no one tenant: they
--     are backfilled, exactly once (when the column is added), to the reserved sentinel workspace
--     'ws_legacy_pooled', which no brain reads (packages/brain LEGACY_POOLED_WORKSPACE_ID; the engine
--     and workspace-create refuse to create a workspace with that id). The column default is then
--     'ws_default', for an older writer that doesn't name a workspace. A re-run never moves a row.
--     Operator note: a single-tenant deployment (all those deals were one customer's) may hand them
--     to that workspace with one statement:
--       update public.brain_profiles set workspace_id = 'ws_<id>' where workspace_id = 'ws_legacy_pooled';
--     (fails on a business that already has a row in ws_<id>; delete or merge that one first.)
--   * No foreign key to public.workspaces: scripts/migration-compat.sh applies the brain's 2xx files
--     on databases at every engine checkpoint, from 100 on, before 103 creates `workspaces`. The
--     check constraint enforces the workspace id format instead (103's workspaces.id check).
--   * Deploy order: apply this before the server build that scopes the brain (it queries workspace_id;
--     that build's /ready reports checks.brain schema_missing until it is applied).
-- Safe to re-run: the column, check, key and index steps are each guarded.

do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'brain_profiles' and column_name = 'workspace_id') then
    -- Adding the column with this default fills every existing row with the sentinel (and nothing else).
    alter table public.brain_profiles add column workspace_id text not null default 'ws_legacy_pooled';
    alter table public.brain_profiles alter column workspace_id set default 'ws_default';
  end if;
end $$;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.brain_profiles'::regclass and conname = 'brain_profiles_workspace_id_check') then
    alter table public.brain_profiles add constraint brain_profiles_workspace_id_check check (workspace_id ~ '^ws_[a-z0-9_]{3,40}$');
  end if;
end $$;

-- The primary key becomes (workspace_id, business_id): the same business is one row per workspace.
-- PostgREST's upsert (on_conflict=workspace_id,business_id) needs exactly this unique key.
do $$
declare
  pk_name text;
  pk_cols text[];
begin
  select c.conname, array_agg(a.attname::text order by k.ord)
    into pk_name, pk_cols
    from pg_constraint c
    cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'public.brain_profiles'::regclass and c.contype = 'p'
   group by c.conname;
  if pk_cols is distinct from array['workspace_id', 'business_id'] then
    if pk_name is not null then
      execute format('alter table public.brain_profiles drop constraint %I', pk_name);
    end if;
    alter table public.brain_profiles add constraint brain_profiles_pkey primary key (workspace_id, business_id);
  end if;
end $$;

-- Every list() is one workspace's (and one category's, for estimates and price checks).
drop index if exists public.brain_profiles_category_area_idx;
create index if not exists brain_profiles_workspace_category_area_idx on public.brain_profiles (workspace_id, category, area);

-- RLS stays forced with no policies and the 201 grants are table-wide: service_role only, as before.
