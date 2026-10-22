#!/usr/bin/env bash
# Mock-mode end-to-end smoke: starts the BUILT server (as Manufact runs it) with HAGGLE_MODE=mock on
# a local port, runs apps/mcp/scripts/smoke.ts against it (/health, /ready, MCP initialize and
# tools/list, one simulated deal to a quote, then cancelled) and stops the server. No credential,
# provider, database or network beyond 127.0.0.1. Run `npm run build` first.
# Usage: scripts/smoke-local.sh            (SMOKE_PORT picks the port; default 3999)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${SMOKE_PORT:-3999}"
BUILD_LABEL="${HAGGLE_BUILD_SHA:-localsmoke}"
[ -f "$ROOT/apps/mcp/.mcp-use/build/index.js" ] || { echo "no build: run npm run build first" >&2; exit 2; }
BIN="$ROOT/node_modules/.bin/mcp-use"
[ -x "$BIN" ] || BIN="$ROOT/apps/mcp/node_modules/.bin/mcp-use"

LOG="$(mktemp -t haggle-smoke-local.XXXXXX)"
# A clean environment: only what a mock server needs. Nothing from the caller's shell or any .env
# reaches it (no provider key, no database URL), so it can't be anything but a mock server.
env -i PATH="$PATH" HOME="${HOME:-/tmp}" PORT="$PORT" HAGGLE_ENV=development HAGGLE_MODE=mock HAGGLE_SIM_DELAY_SCALE=0 HAGGLE_BUILD_SHA="$BUILD_LABEL" \
  bash -c "cd '$ROOT/apps/mcp' && exec '$BIN' start --port '$PORT'" >"$LOG" 2>&1 &
PID=$!
cleanup() { kill "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then echo "server exited during start-up:" >&2; tail -n 30 "$LOG" >&2; exit 1; fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "server did not answer /health on port $PORT" >&2; tail -n 30 "$LOG" >&2; exit 1; }

env -i PATH="$PATH" HOME="${HOME:-/tmp}" node "$ROOT/apps/mcp/scripts/smoke.ts" "http://127.0.0.1:$PORT" --expect-build "$BUILD_LABEL"
