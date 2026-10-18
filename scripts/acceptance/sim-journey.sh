#!/usr/bin/env bash
# The complete simulated purchase over MCP HTTP, with restarts, on a throwaway Postgres 17 (Docker).
# No outreach, no Stripe call. Usage: scripts/acceptance/sim-journey.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="haggle-simjourney-$$"
PORT="${PGTEST_PORT:-55433}"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -p "127.0.0.1:$PORT:5432" postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done
psql() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
SQL
for f in "$ROOT"/supabase/migrations/*.sql; do psql < "$f"; done
cd "$ROOT" && npm run build -w @haggle/mcp >/dev/null
HAGGLE_TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:$PORT/postgres" "$ROOT/node_modules/.bin/vitest" run apps/mcp/tests/simJourney.e2e.test.ts
