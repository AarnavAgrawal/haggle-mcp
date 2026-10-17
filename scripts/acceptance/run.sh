#!/usr/bin/env bash
# Haggle acceptance harness, local gates (no network to businesses, no charges).
#   scripts/acceptance/run.sh            # clean install + all local gates
#   scripts/acceptance/run.sh --live URL [JOB_ID]   # + read-only checks against a deployed server
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"; cd "$ROOT"
step() { printf '\n== %s\n' "$1"; }
step "clean install (npm ci)";            npm ci --no-audit --no-fund >/dev/null
step "typecheck";                         npm run typecheck >/dev/null && echo PASS
step "build (MCP + views)";               npm run build -w @haggle/mcp | tail -1
step "all tests (unit, engine, transport e2e incl. six-seller mock regression)"; npm test 2>&1 | grep -E "Test Files|Tests "
step "migrations + security assertions (Docker Postgres 17)"; scripts/verify-migrations.sh | grep -E "passed|OK"
step "engine suite on real Postgres";     scripts/test-postgres.sh 2>&1 | grep -E "Tests "
if [ "${1:-}" = "--live" ]; then
  step "live read-only checks: ${2}";     node scripts/acceptance/live-readonly.mjs "${2}" "${3:-}" apps/mcp/.env
fi
echo; echo "acceptance: local gates passed"
