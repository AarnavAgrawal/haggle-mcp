#!/usr/bin/env bash
# Applies supabase/migrations to a throwaway Postgres and runs the SQL assertions (supabase/tests/*.sql).
# Then re-applies the migration ledger (111, idempotent) and checks the ledger script's view of it.
# Docker by default; with HAGGLE_PG_ADMIN_URL (CI service container) a throwaway database on that server.
# Usage: scripts/verify-migrations.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=pg-common.sh
. "$ROOT/scripts/pg-common.sh"
pg_start migrate-check

pg_apply_migrations "$ROOT"

for t in "$ROOT"/supabase/tests/*.sql; do echo "running $(basename "$t")"; pg_sql < "$t"; done

# The ledger migration must be safe to re-run (operators may apply it twice).
pg_sql < "$ROOT/supabase/migrations/111_engine_ops.sql"
echo "re-applied 111_engine_ops.sql (idempotent)"

# Every engine migration after the ledger (112+) is written on its own branch: each must also apply
# on top of 100-111 alone, in a fresh database, without the others (docs/deployment.md, section 4).
iso=0
for f in "$ROOT"/supabase/migrations/1*_engine_*.sql; do
  n="$(basename "$f" | cut -c1-3)"
  [ "$n" -gt 111 ] || continue
  db="haggle_iso_${n}_$$"
  echo "create database \"$db\"" | pg_sql
  for b in "$ROOT"/supabase/migrations/1*_engine_*.sql; do
    [ "$(basename "$b" | cut -c1-3)" -le 111 ] && pg_sql_on "$db" < "$b"
  done
  pg_sql_on "$db" < "$f"
  echo "drop database \"$db\" with (force)" | pg_sql
  echo "applied $(basename "$f") alone on top of 100-111"
  iso=$((iso + 1))
done
[ "$iso" -gt 0 ] || echo "no engine migration after 111 to check in isolation"
echo "migrations OK"
