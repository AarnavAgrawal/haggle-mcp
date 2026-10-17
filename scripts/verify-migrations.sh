#!/usr/bin/env bash
# Applies supabase/migrations to a throwaway Postgres container and runs SQL assertions.
# Requires Docker. Usage: scripts/verify-migrations.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="haggle-migrate-check-$$"
IMAGE="${PG_IMAGE:-postgres:17-alpine}"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -q 2>/dev/null && break
  sleep 0.5
done
# pg_isready can pass before the init scripts finish; wait for a real query.
for _ in $(seq 1 60); do
  docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 0.5
done

psql() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

# Supabase's built-in roles, so the migrations' grants/revokes apply as in production.
psql <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
SQL

for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "applying $(basename "$f")"
  psql < "$f"
done

for t in "$ROOT"/supabase/tests/*.sql; do echo "running $(basename "$t")"; psql < "$t"; done
echo "migrations OK"
