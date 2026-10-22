#!/usr/bin/env bash
# Shared by verify-migrations.sh and test-postgres.sh (sourced, not run). Gives each script its own
# throwaway database, in one of two ways:
#   * HAGGLE_PG_ADMIN_URL set (CI: a postgres:17 service container): a fresh database is created on
#     that server for this run and dropped afterwards; SQL goes through the host `psql`
#     (override with PSQL="..."). The URL must point at a disposable server, never a real database.
#   * otherwise: a postgres:17-alpine Docker container (local default), removed afterwards.
# After pg_start: PG_URL (host-reachable connection string, when there is one) and pg_sql (runs SQL
# from stdin with ON_ERROR_STOP). Supabase's anon/authenticated/service_role roles are created.
set -euo pipefail

pg_cleanup() {
  if [ -n "${PG_DOCKER_NAME:-}" ]; then docker rm -f "$PG_DOCKER_NAME" >/dev/null 2>&1 || true; fi
  if [ -n "${PG_DB_NAME:-}" ]; then
    ${PSQL:-psql} "$HAGGLE_PG_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$PG_DB_NAME\" with (force)" >/dev/null 2>&1 || true
  fi
}

# pg_start <label> [host port to publish in docker mode]
pg_start() {
  local label="$1" port="${2:-}"
  trap pg_cleanup EXIT
  if [ -n "${HAGGLE_PG_ADMIN_URL:-}" ]; then
    # Refuse anything that isn't obviously a disposable local/CI server.
    case "$HAGGLE_PG_ADMIN_URL" in
      postgres://*@localhost[:/]*|postgres://*@127.0.0.1[:/]*|postgresql://*@localhost[:/]*|postgresql://*@127.0.0.1[:/]*|postgres://*@postgres[:/]*|postgresql://*@postgres[:/]*) ;;
      *) echo "HAGGLE_PG_ADMIN_URL must point at a local or CI service database (localhost, 127.0.0.1 or the 'postgres' service host)" >&2; exit 2 ;;
    esac
    PG_DB_NAME="haggle_${label}_$$_${RANDOM}"
    ${PSQL:-psql} "$HAGGLE_PG_ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "create database \"$PG_DB_NAME\""
    PG_URL="$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.href)' "$HAGGLE_PG_ADMIN_URL" "$PG_DB_NAME")"
    pg_sql() { ${PSQL:-psql} "$PG_URL" -v ON_ERROR_STOP=1 -q; }
  else
    PG_DOCKER_NAME="haggle-${label}-$$"
    local publish=()
    if [ -n "$port" ]; then publish=(-p "127.0.0.1:$port:5432"); fi
    docker run -d --name "$PG_DOCKER_NAME" -e POSTGRES_PASSWORD=postgres ${publish[@]+"${publish[@]}"} "${PG_IMAGE:-postgres:17-alpine}" >/dev/null
    for _ in $(seq 1 60); do docker exec "$PG_DOCKER_NAME" pg_isready -U postgres -q 2>/dev/null && break; sleep 0.5; done
    # pg_isready can pass before the init scripts finish; wait for a real query.
    for _ in $(seq 1 60); do docker exec "$PG_DOCKER_NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1 && break; sleep 0.5; done
    PG_URL=""
    if [ -n "$port" ]; then PG_URL="postgres://postgres:postgres@127.0.0.1:$port/postgres"; fi
    pg_sql() { docker exec -i "$PG_DOCKER_NAME" psql -U postgres -v ON_ERROR_STOP=1 -q; }
  fi
  # Supabase's built-in roles (cluster-wide, so only when missing), so grants/revokes apply as in production.
  pg_sql <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
SQL
}

# Applies every supabase/migrations file in order.
pg_apply_migrations() {
  local root="$1" f
  for f in "$root"/supabase/migrations/*.sql; do
    [ -n "${PG_QUIET:-}" ] || echo "applying $(basename "$f")"
    pg_sql < "$f"
  done
}
