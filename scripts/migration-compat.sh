#!/usr/bin/env bash
# Upgrade compatibility of supabase/migrations on throwaway databases (never a real one):
#   1. The live database's path: a database at 102 (100-102 applied, no ledger: the sprint-4 audit's
#      state) holding demo-era rows (migration-compat/seed_at_102.sql) gets every later engine file
#      one at a time, each in a single transaction as `psql -1 -f` applies it; then the operator's
#      ledger steps run through the real CLI (migrations.ts backfill --through 102, record, verify);
#      then migration-compat/check_upgraded.sql checks the old rows survived and the new triggers hold.
#   2. Every checkpoint: for each engine migration N, a database with the engine files <= N and the
#      brain's 2xx files (applied out of numeric order, as on a database where the brain was set up
#      first) gets the remaining engine files in order.
# File lists come from the directory, so a new migration (sprint 5: 118, 119, 121, 122, ...) is
# covered without editing this script.
# Docker by default (MIGCOMPAT_PORT, default 55463, published on 127.0.0.1 for the ledger CLI); with
# HAGGLE_PG_ADMIN_URL (CI service container) throwaway databases on that server.
# Usage: scripts/migration-compat.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=pg-common.sh
. "$ROOT/scripts/pg-common.sh"
pg_start migrate-compat "${MIGCOMPAT_PORT:-55463}"
MIG="$ROOT/supabase/migrations"
num() { basename "$1" | cut -c1-3; }
# One migration in one transaction, like `psql -1 -f`.
apply_on() { local db="$1" f="$2"; { echo 'set client_min_messages = warning; begin;'; cat "$f"; echo 'commit;'; } | pg_sql_on "$db"; }
engine_files() { printf '%s\n' "$MIG"/1*_engine_*.sql | sort; }
brain_files() { local f; for f in "$MIG"/2*_brain_*.sql; do [ -e "$f" ] && echo "$f"; done; return 0; }
url_for() { node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.href)' "$PG_URL" "$1"; }
[ -n "$PG_URL" ] || { echo "migration-compat needs a host-reachable database (MIGCOMPAT_PORT)" >&2; exit 2; }

# ---- 1. the live database's path: 102 with rows -> latest, through the ledger CLI ----
DB="haggle_compat_live_$$"
echo "create database \"$DB\"" | pg_sql
for f in $(engine_files); do [ "$(num "$f")" -le 102 ] && apply_on "$DB" "$f"; done
pg_sql_on "$DB" < "$ROOT/scripts/migration-compat/seed_at_102.sql"
echo "database at 102 with demo-era rows"
for f in $(engine_files); do
  [ "$(num "$f")" -gt 102 ] || continue
  apply_on "$DB" "$f"
  echo "  upgraded: $(basename "$f")"
done
# The operator's ledger steps (docs/deployment.md §4), with the real script. A disposable local URL:
# no HAGGLE_PROD_DB_HOSTS match, development target; nothing else from the caller's environment.
ledger() { env -i PATH="$PATH" HOME="${HOME:-/tmp}" HAGGLE_ENV=development SUPABASE_DB_URL="$(url_for "$DB")" node "$ROOT/apps/mcp/scripts/migrations.ts" "$@"; }
ledger backfill --through 102_engine_stripe.sql --confirm >/dev/null
for f in $(engine_files); do [ "$(num "$f")" -gt 102 ] && ledger record "$(basename "$f")" --confirm >/dev/null; done
ledger verify >/dev/null || { ledger status; echo "ledger verify failed after the upgrade" >&2; exit 1; }
echo "  ledger: backfill through 102, record 103+, verify OK"
pg_sql_on "$DB" < "$ROOT/scripts/migration-compat/check_upgraded.sql"
echo "  demo-era rows intact; safety triggers hold on them"
# The brain's files after the engine's (Aarnav applies them separately); engine verify stays OK.
for f in $(brain_files); do apply_on "$DB" "$f"; done
ledger verify >/dev/null || { echo "ledger verify failed after the brain migrations" >&2; exit 1; }
echo "drop database \"$DB\" with (force)" | pg_sql
echo "live path OK: 102 + rows -> $(basename "$(engine_files | tail -1)")"

# ---- 2. every checkpoint N: engine <= N, then the brain, then engine > N ----
LAST="$(num "$(engine_files | tail -1)")"
n_cp=0
for cp in $(engine_files); do
  c="$(num "$cp")"
  [ "$c" -lt "$LAST" ] || continue
  db="haggle_compat_cp_${c}_$$"
  echo "create database \"$db\"" | pg_sql
  for f in $(engine_files); do [ "$(num "$f")" -le "$c" ] && apply_on "$db" "$f"; done
  for f in $(brain_files); do apply_on "$db" "$f"; done
  for f in $(engine_files); do [ "$(num "$f")" -gt "$c" ] && apply_on "$db" "$f"; done
  echo "drop database \"$db\" with (force)" | pg_sql
  n_cp=$((n_cp + 1))
done
echo "checkpoints OK: $n_cp databases upgraded from each engine migration to $LAST"
echo "migration compatibility OK"
