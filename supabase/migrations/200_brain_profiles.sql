-- Brain (Aarnav): learned business profiles. Read/written only by the server with the
-- service-role key (packages/brain SupabaseStore). The full Profile (packages/core/contracts.ts)
-- lives in `profile`; the other columns are for filtering and humans.

create table if not exists public.brain_profiles (
  business_id text primary key,
  name        text not null,
  category    text not null,
  area        text,
  profile     jsonb not null,
  updated_at  timestamptz not null default now()
);

create index if not exists brain_profiles_category_area_idx on public.brain_profiles (category, area);

-- No policies: anon/authenticated get nothing; only service_role (server side) can read or write.
alter table public.brain_profiles enable row level security;
alter table public.brain_profiles force row level security;
