#!/usr/bin/env bash
# E2E runner (spec 7.1 G1-D, spec 8). Owner G1-D.
#
#   bash tests/e2e/run.sh                         # every tests/e2e/*.test.mjs, one server for the run
#   bash tests/e2e/run.sh path/to/x.test.mjs ...  # only the files given
#   bash tests/e2e/run.sh --serve                 # start the fixture server and wait (prints BASE_URL etc.)
#
# Flags and env:
#   --root DIR | ROOT=DIR   serve another checkout (its functions/, crm/dashboard and wrangler.toml); the
#                           migrations, seed and tests still come from this repo. Used for the golden capture.
#   --bare | BARE=1         skip migrations 003/004 (the T29 shape). Tests can also start their own bare
#                           server: startServer({extra: false}) in tests/e2e/lib.mjs.
#   --keep | KEEP=1         keep the persist dir after the run (its path is printed)
#   PORT=n                  fixed port (default: a free one; 8788 is refused)
#   FIXTURE_TODAY=YYYY-MM-DD   the day the fixture dates count from (default: today, local time)
#   NO_SEED=1               migrations only, no fixture rows
#
# Each run: a free port, a unique --inspector-port, a fresh `mktemp -d` persist dir, migrations
# 001 -> 003 -> 004 (files holding only comments are skipped), the synthetic seed from
# tests/fixtures/make-seed.mjs (003/004 rows only when those tables exist), then
# `wrangler pages dev --binding DASHBOARD_PASSWORD=testpass`. Tests run with `node --test --test-concurrency=1`
# and get BASE_URL, PORT, INSPECTOR_PORT, PERSIST_DIR, SERVE_ROOT, HARNESS_ROOT, FIXTURE_TODAY, D1_TABLES,
# OUT_DIR, DASHBOARD_PASSWORD and the tool paths in their env. The server is stopped at the end (also on Ctrl-C).
# Local D1 only: --remote is refused, and nothing here ever talks to Cloudflare.
set -euo pipefail

for a in "$@"; do
  case "$a" in
    --remote|--remote=*) echo "run.sh: --remote is not allowed; tests use local D1 only." >&2; exit 2 ;;
  esac
done

HARNESS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

WRANGLER_BIN="${WRANGLER_BIN:-/tmp/wtest/node_modules/.bin/wrangler}"
PW_PATH="${PW_PATH:-/opt/node22/lib/node_modules/playwright}"
CHROME="${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"
AXE_PATH="${AXE_PATH:-/tmp/claude-0/-home-claude-partnergapcrm/747cd0be-8b1d-5f07-83a7-c4a3d39a6045/scratchpad/redesign/audit/tools/node_modules/axe-core/axe.min.js}"
export WRANGLER_BIN PW_PATH CHROME AXE_PATH WRANGLER_SEND_METRICS=false

missing=0
[ -x "$WRANGLER_BIN" ] || { echo "run.sh: WRANGLER_BIN not found or not executable: $WRANGLER_BIN" >&2; missing=1; }
[ -d "$PW_PATH" ] || { echo "run.sh: PW_PATH not found: $PW_PATH" >&2; missing=1; }
[ -x "$CHROME" ] || { echo "run.sh: CHROME not found or not executable: $CHROME" >&2; missing=1; }
[ -f "$AXE_PATH" ] || { echo "run.sh: AXE_PATH not found: $AXE_PATH" >&2; missing=1; }
command -v node >/dev/null || { echo "run.sh: node is not on PATH" >&2; missing=1; }
[ "$missing" = 0 ] || exit 3

if [ "${PORT:-}" = 8788 ] || [ "${INSPECTOR_PORT:-}" = 8788 ]; then
  echo "run.sh: port 8788 belongs to the main dev server; pick another." >&2
  exit 2
fi

# The Node side (tests/e2e/lib.mjs) starts the server, runs node --test and always stops the server.
exec node "$HARNESS/tests/e2e/lib.mjs" run "$@"
