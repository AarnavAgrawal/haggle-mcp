#!/usr/bin/env bash
# Applies supabase/migrations to a throwaway Postgres and runs the SQL assertions (supabase/tests/*.sql).
# Then re-applies every migration whose header says it is safe to re-run (the ledger, 111, and any
# file declaring itself idempotent), and applies each parallel-branch migration alone on its base.
# Docker by default; with HAGGLE_PG_ADMIN_URL (CI service container) a throwaway database on that server.
# Upgrade paths from older databases (with rows) are scripts/migration-compat.sh.
# Usage: scripts/verify-migrations.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Parallel-branch groups (docs/deployment.md §4). Each engine migration numbered above a base must apply
# on that base alone (every engine file up to and including it), without its siblings: sprint 4's
# 112-117 on 100-111, sprint 5's 118+ on 100-117. THE ONE HAND-KEPT LIST: add the last number of a
# merged sprint here when a new parallel sprint starts (apps/mcp/tests/ciRelease.test.ts checks it).
ISOLATION_BASES="111 117"
# shellcheck source=pg-common.sh
. "$ROOT/scripts/pg-common.sh"
pg_start migrate-check

pg_apply_migrations "$ROOT"

for t in "$ROOT"/supabase/tests/*.sql; do echo "running $(basename "$t")"; pg_sql < "$t"; done

# Migrations that declare themselves safe to re-run (operators may apply them twice) must be.
reapplied=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  if head -n 20 "$f" | grep -qiE 'safe to re-run|idempotent \(re-running'; then
    pg_sql < "$f"
    echo "re-applied $(basename "$f") (idempotent)"
    reapplied=$((reapplied + 1))
  fi
done
[ "$reapplied" -gt 0 ] || { echo "no migration declares itself re-runnable (expected at least 111_engine_ops.sql)" >&2; exit 1; }

# The isolation base of migration number $1: the highest base below it ("" = none: in order only).
base_of() { local n="$1" b out=""; for b in $ISOLATION_BASES; do if [ "$((10#$n))" -gt "$((10#$b))" ]; then out="$b"; fi; done; echo "$out"; }

iso=0
for f in "$ROOT"/supabase/migrations/1*_engine_*.sql; do
  n="$(basename "$f" | cut -c1-3)"
  base="$(base_of "$n")"
  [ -n "$base" ] || continue
  db="haggle_iso_${n}_$$"
  echo "create database \"$db\"" | pg_sql
  for b in "$ROOT"/supabase/migrations/1*_engine_*.sql; do
    if [ "$((10#$(basename "$b" | cut -c1-3)))" -le "$((10#$base))" ]; then pg_sql_on "$db" < "$b"; fi
  done
  pg_sql_on "$db" < "$f"
  echo "drop database \"$db\" with (force)" | pg_sql
  echo "applied $(basename "$f") alone on top of 100-$base"
  iso=$((iso + 1))
done
[ "$iso" -gt 0 ] || echo "no engine migration after the first isolation base to check"

# 202_brain_tenancy on a brain database that already has profiles (and no engine tables, so no
# public.workspaces): pre-tenancy rows go to the reserved 'ws_legacy_pooled' (pooled from every
# workspace, read by none), later inserts default to 'ws_default', and a re-run moves nothing.
db="haggle_brain_upgrade_$$"
echo "create database \"$db\"" | pg_sql
for f in "$ROOT"/supabase/migrations/200_brain_*.sql "$ROOT"/supabase/migrations/201_brain_*.sql; do pg_sql_on "$db" < "$f"; done
pg_sql_on "$db" <<'SQL'
insert into public.brain_profiles (business_id, name, category, area, profile) values
  ('biz_pre_a', 'Pre A', 'catering', 'SF', '{}'), ('biz_pre_b', 'Pre B', 'catering', 'SF', '{}');
SQL
pg_sql_on "$db" < "$ROOT/supabase/migrations/202_brain_tenancy.sql"
pg_sql_on "$db" <<'SQL'
do $$ begin
  if to_regclass('public.workspaces') is not null then raise exception 'test setup: workspaces should not exist here'; end if;
  if (select count(*) from public.brain_profiles where workspace_id = 'ws_legacy_pooled') <> 2 then raise exception 'pre-tenancy rows were not parked in ws_legacy_pooled'; end if;
  if exists (select 1 from public.brain_profiles where workspace_id <> 'ws_legacy_pooled') then raise exception 'a pre-tenancy row landed in a real workspace'; end if;
end $$;
-- After 202: a writer without a workspace lands in ws_default; the brain's scoped writes in their own.
insert into public.brain_profiles (business_id, name, category, profile) values ('biz_post_default', 'Post', 'catering', '{}');
insert into public.brain_profiles (workspace_id, business_id, name, category, profile) values ('ws_alpha', 'biz_pre_a', 'Pre A', 'catering', '{}');
SQL
pg_sql_on "$db" < "$ROOT/supabase/migrations/202_brain_tenancy.sql"
pg_sql_on "$db" <<'SQL'
do $$ begin
  if (select string_agg(workspace_id || ':' || business_id, ',' order by workspace_id, business_id) from public.brain_profiles)
     <> 'ws_alpha:biz_pre_a,ws_default:biz_post_default,ws_legacy_pooled:biz_pre_a,ws_legacy_pooled:biz_pre_b' then
    raise exception 're-running 202 moved rows: %', (select string_agg(workspace_id || ':' || business_id, ',' order by workspace_id, business_id) from public.brain_profiles);
  end if;
  if (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'brain_profiles' and column_name = 'workspace_id') not like '''ws_default''%' then
    raise exception 'workspace_id default is not ws_default after a re-run';
  end if;
end $$;
SQL
echo "drop database \"$db\" with (force)" | pg_sql
echo "202_brain_tenancy on a populated brain: old rows to ws_legacy_pooled, new rows default to ws_default, re-run moves nothing"
echo "migrations OK"
