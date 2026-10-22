-- 111_engine_ops (owner: Yash). Operations: the migration ledger.
--   * engine_migrations: which supabase/migrations files were applied to this database, with the
--     SHA-256 of each file as applied. Applying stays an operator step (psql / SQL editor); the ledger is
--     filled by `apps/mcp/scripts/migrations.ts record|backfill`, and read by the server's /ready and by
--     `migrations.ts status` to report missing migrations and checksum drift.
--   * This migration records itself (checksum filled by `record`, since a file can't hash itself).
-- Additive only; depends on nothing but the schema existing. Safe to re-run.

create table if not exists public.engine_migrations (
  name        text primary key check (name ~ '^[0-9]{3}_[a-z0-9_]+\.sql$'),
  checksum    text check (checksum is null or checksum ~ '^[0-9a-f]{64}$'),
  applied_at  timestamptz not null default now(),
  recorded_by text check (recorded_by is null or length(recorded_by) <= 100)
);

insert into public.engine_migrations (name, checksum, recorded_by)
  values ('111_engine_ops.sql', null, 'migration 111')
  on conflict (name) do nothing;

alter table public.engine_migrations enable row level security;
alter table public.engine_migrations force row level security;
revoke all on public.engine_migrations from anon, authenticated;
