#!/usr/bin/env bash
# Runs the engine and apps/mcp suites with the wall clock moved, to prove no test depends on the real
# date. Tests run the engine on fixed fake clocks (e.g. 2026-10-22); a store or helper stamping real
# time against them, or a literal "future" date, breaks once real time passes it. scripts/clock-skew.mjs
# is preloaded into every Node process (vitest workers and the servers the e2e suites spawn).
# Usage: scripts/test-clock-skew.sh [vitest args]   (default: packages/engine apps/mcp)
#   HAGGLE_TEST_CLOCK_SKEWS="2027-10-22T12:00:00Z ..."  the dates to run at (default: a year after the
#   fixtures' dates, before them, and just after their event dates).
# The e2e suites start the built server: run `npm run build` first.
# Postgres: the database's now() can't be skewed, so a skewed JS clock only disagrees with it. What
# does carry over is a clock behind the database, as fixed-date tests will be once real time moves on:
#   HAGGLE_TEST_CLOCK_SKEW=2025-10-22T12:00:00Z NODE_OPTIONS="--import $PWD/scripts/clock-skew.mjs" scripts/test-postgres.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
read -r -a skews <<< "${HAGGLE_TEST_CLOCK_SKEWS:-2027-10-22T12:00:00Z 2026-01-15T12:00:00Z 2026-11-20T12:00:00Z}"
if [ $# -eq 0 ]; then set -- packages/engine apps/mcp; fi
for at in "${skews[@]}"; do
  echo "== vitest with the clock at $at"
  HAGGLE_TEST_CLOCK_SKEW="$at" NODE_OPTIONS="${NODE_OPTIONS:-} --import $ROOT/scripts/clock-skew.mjs" \
    "$ROOT/node_modules/.bin/vitest" run "$@"
done
