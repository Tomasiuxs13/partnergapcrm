#!/usr/bin/env bash
# E2E runner (spec 7.1 G1-D, 8). G0 skeleton; owner G1-D.
#
#   bash tests/e2e/run.sh                     # every tests/e2e/*.test.mjs
#   bash tests/e2e/run.sh path/to/x.test.mjs  # only the files given
#
# Starts its own `wrangler pages dev` on a free port with a unique inspector port and a fresh
# `mktemp -d` persist dir, applies the migrations, runs `node --test`, then stops the server.
# Local D1 only: it never passes --remote, refuses it as an argument, and never uses port 8788.
# Tests get BASE_URL, PORT, PERSIST_DIR, DASHBOARD_PASSWORD and the tool paths in their env.
# KEEP=1 keeps the persist dir (its path is printed) for debugging.
#
# Still to do (G1-D): the fixture seed from tests/fixtures/make-seed.mjs, and a second server
# without 003/004 for T29.
set -euo pipefail

for a in "$@"; do
  case "$a" in
    --remote|--remote=*) echo "run.sh: --remote is not allowed; tests use local D1 only." >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WRANGLER_BIN="${WRANGLER_BIN:-/tmp/wtest/node_modules/.bin/wrangler}"
PW_PATH="${PW_PATH:-/opt/node22/lib/node_modules/playwright}"
CHROME="${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}"
AXE_PATH="${AXE_PATH:-/tmp/claude-0/-home-claude-partnergapcrm/747cd0be-8b1d-5f07-83a7-c4a3d39a6045/scratchpad/redesign/audit/tools/node_modules/axe-core/axe.min.js}"
export WRANGLER_BIN PW_PATH CHROME AXE_PATH

missing=0
[ -x "$WRANGLER_BIN" ] || { echo "run.sh: WRANGLER_BIN not found or not executable: $WRANGLER_BIN" >&2; missing=1; }
[ -d "$PW_PATH" ] || { echo "run.sh: PW_PATH not found: $PW_PATH" >&2; missing=1; }
[ -x "$CHROME" ] || { echo "run.sh: CHROME not found or not executable: $CHROME" >&2; missing=1; }
[ -f "$AXE_PATH" ] || { echo "run.sh: AXE_PATH not found: $AXE_PATH" >&2; missing=1; }
command -v node >/dev/null || { echo "run.sh: node is not on PATH" >&2; missing=1; }
command -v curl >/dev/null || { echo "run.sh: curl is not on PATH" >&2; missing=1; }
[ "$missing" = 0 ] || exit 3

free_port() {
  node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'
}

PORT="${PORT:-$(free_port)}"
INSPECTOR_PORT="${INSPECTOR_PORT:-$(free_port)}"
if [ "$PORT" = 8788 ] || [ "$INSPECTOR_PORT" = 8788 ]; then
  echo "run.sh: port 8788 belongs to the main dev server; pick another." >&2
  exit 2
fi
PERSIST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pgcrm-e2e.XXXXXX")"
BASE_URL="http://127.0.0.1:$PORT"
OUT_DIR="$ROOT/tests/e2e/out"
mkdir -p "$OUT_DIR"
export PORT INSPECTOR_PORT PERSIST_DIR BASE_URL OUT_DIR
export DASHBOARD_PASSWORD=testpass WRANGLER_SEND_METRICS=false

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill -TERM -- "-$SERVER_PID" 2>/dev/null || kill -TERM "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "${KEEP:-0}" = 1 ]; then echo "run.sh: kept $PERSIST_DIR" >&2; else rm -rf "$PERSIST_DIR"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Local D1 only. The binding name comes from wrangler.toml.
d1() { "$WRANGLER_BIN" d1 execute PARTNERS_DB --local --persist-to "$PERSIST_DIR" "$@"; }

# Migrations 001 -> 003 -> 004. A file with no statements yet (a G0 stub) is skipped.
for f in 001_base.sql 003_site_meta.sql 004_suggestions_runs.sql; do
  p="$ROOT/crm/scripts/migrations/$f"
  if [ -f "$p" ] && grep -Eqv '^[[:space:]]*(--.*)?$' "$p"; then
    d1 --file "$p" >"$PERSIST_DIR/migrate-$f.log" 2>&1 || { cat "$PERSIST_DIR/migrate-$f.log" >&2; exit 4; }
  fi
done

# TODO(G1-D): node tests/fixtures/make-seed.mjs > "$PERSIST_DIR/seed.sql" && d1 --file "$PERSIST_DIR/seed.sql"

# setsid puts wrangler and its workerd children in their own process group, so cleanup stops all.
setsid "$WRANGLER_BIN" pages dev crm/dashboard --ip 127.0.0.1 --port "$PORT" \
  --inspector-port "$INSPECTOR_PORT" --persist-to "$PERSIST_DIR" \
  --binding DASHBOARD_PASSWORD=testpass >"$PERSIST_DIR/wrangler.log" 2>&1 &
SERVER_PID=$!

ready=0
for _ in $(seq 1 120); do
  if curl -s -o /dev/null --max-time 2 "$BASE_URL/login"; then ready=1; break; fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ "$ready" != 1 ]; then
  echo "run.sh: the dev server did not start on $BASE_URL" >&2
  tail -n 40 "$PERSIST_DIR/wrangler.log" >&2 || true
  exit 5
fi
echo "run.sh: server on $BASE_URL (inspector $INSPECTOR_PORT, persist $PERSIST_DIR)" >&2

if [ "$#" -gt 0 ]; then
  files=("$@")
else
  shopt -s nullglob
  files=("$ROOT"/tests/e2e/*.test.mjs)
  shopt -u nullglob
fi
if [ "${#files[@]}" = 0 ]; then echo "run.sh: no test files" >&2; exit 0; fi

status=0
node --test --test-concurrency=1 "${files[@]}" || status=$?
exit "$status"
