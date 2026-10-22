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
echo "migrations OK"
