-- 303_web_waitlist: who has asked for Haggle and who the operator has let in (apps/web).
-- Sign-up is by invitation: a person gets a workspace only once their row has admitted_at set, which only
-- the operator's script does (apps/web/scripts/waitlist-admin.ts). A null admitted_at means waiting.
-- The web backend reads and writes this with the service role; anon and authenticated get nothing, because
-- the rows are strangers' names and emails and a row is what grants access. There are no policies on purpose.
-- Not tied to auth.users: most people on the list have no account yet, so account deletion removes the row by
-- email (apps/web/lib/account/server.ts). Emails are stored lowercase, so one person has one row, and only in
-- the characters real addresses use: the operator's tools put them in a command line, so never shell characters.
-- Additive only. Safe to re-run (idempotent: if-not-exists and guarded grant).

create table if not exists public.web_waitlist (
  id           uuid primary key default gen_random_uuid(),
  email        text not null unique check (email ~ '^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' and length(email) <= 254),
  full_name    text not null check (length(btrim(full_name)) between 1 and 120),
  organization text not null check (length(btrim(organization)) between 1 and 160),
  use_case     text check (use_case is null or length(use_case) <= 500),
  created_at   timestamptz not null default now(),
  admitted_at  timestamptz,
  admitted_by  text check (admitted_by is null or length(admitted_by) between 1 and 200),
  notified_at  timestamptz,
  constraint web_waitlist_admitted_by_whom check ((admitted_at is null) = (admitted_by is null)),
  constraint web_waitlist_notified_after_admitted check (notified_at is null or admitted_at is not null)
);
create index if not exists web_waitlist_waiting_idx on public.web_waitlist (created_at) where admitted_at is null;

alter table public.web_waitlist enable row level security;
alter table public.web_waitlist force row level security;
revoke all on public.web_waitlist from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.web_waitlist to service_role;
  end if;
end $$;
