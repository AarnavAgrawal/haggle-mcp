-- 302_web_profiles: per-user web app profile (apps/web): when the user accepted the Terms and Acceptable
-- Use policy at onboarding, and which version (apps/web/lib/account/legal.ts TERMS_VERSION).
-- The web backend writes with the service role; users read only their own row. Nobody else writes it.
-- Deleting the account removes the row (apps/web/lib/account/delete.ts; the auth.users foreign key also cascades).
-- Safe to re-run (idempotent: if-not-exists and guarded policy/foreign key).
--
-- The link to auth.users and the row-level-security policy need Supabase's auth schema; on a plain
-- Postgres (scripts/verify-migrations.sh) the table is created without them.

create table if not exists public.web_profiles (
  user_id           uuid primary key,
  accepted_terms_at timestamptz,
  terms_version     text,
  created_at        timestamptz not null default now()
);
alter table public.web_profiles enable row level security;

do $$
begin
  if to_regclass('auth.users') is not null then
    if not exists (select 1 from pg_constraint where conname = 'web_profiles_user_fk') then
      alter table public.web_profiles
        add constraint web_profiles_user_fk foreign key (user_id) references auth.users(id) on delete cascade;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'web_profiles' and policyname = 'users read their own profile') then
      execute 'create policy "users read their own profile" on public.web_profiles for select to authenticated using (user_id = auth.uid())';
    end if;
  end if;
end $$;
