#!/usr/bin/env bash
# Runs the engine test suite (and the PG-gated apps/mcp ops tests) against a throwaway Postgres 17
# with supabase/migrations applied. Docker by default (PGTEST_PORT, default 55432, is published on
# 127.0.0.1); with HAGGLE_PG_ADMIN_URL (CI service container) a throwaway database on that server.
# Usage: scripts/test-postgres.sh [vitest args]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=pg-common.sh
. "$ROOT/scripts/pg-common.sh"
PG_QUIET=1
pg_start pgtest "${PGTEST_PORT:-55432}"
pg_apply_migrations "$ROOT"
# npm workspaces: run the engine suite from its package (vitest is hoisted to the repo root).
cd "$ROOT/packages/engine"
HAGGLE_TEST_DATABASE_URL="$PG_URL" "$ROOT/node_modules/.bin/vitest" run "$@"
# Every PG-gated apps/mcp test (apps/mcp/tests/*.pg.test.ts: the migration ledger, operator store, and
# staging-release.ts --execute on throwaway databases, which needs a psql client) against the same server.
if [ $# -eq 0 ]; then
  cd "$ROOT"
  HAGGLE_TEST_DATABASE_URL="$PG_URL" "$ROOT/node_modules/.bin/vitest" run apps/mcp/tests/*.pg.test.ts
fi
