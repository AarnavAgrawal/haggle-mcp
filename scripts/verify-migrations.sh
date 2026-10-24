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
echo "migrations OK"
