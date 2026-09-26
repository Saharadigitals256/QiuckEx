#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# local-dev/bootstrap.sh – Bring up local Supabase and Redis with fixtures
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/local-dev/bootstrap.sh              # start/verify services, then seed
#   ./scripts/local-dev/bootstrap.sh --seed-only  # apply fixtures to a running stack
#   ./scripts/local-dev/bootstrap.sh --check      # verify the stack, seed nothing
#   ./scripts/local-dev/bootstrap.sh --reset      # drop local data, then bootstrap
#   ./scripts/local-dev/bootstrap.sh --help
#
# Steps, in order:
#   1. Check the toolchain (Supabase CLI, psql, redis-cli) and report every
#      missing tool at once, rather than failing on the first one.
#   2. Start the local Supabase stack and wait for it to become healthy.
#   3. Wait for Redis to accept PING.
#   4. Apply the migrations, then scripts/local-dev/seed.sql.
#   5. Print the connection values to export.
#
# SAFETY
#   Local development only. The seed aborts unless the target database name is a
#   local one (see the guard at the top of seed.sql), and --reset refuses to run
#   against a non-loopback host. No seed material contains a private key: the
#   fixtures are public keys only, so self-custody (ADR 0001) is preserved.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Local stack coordinates. These match .env.example and the Supabase CLI default.
SUPABASE_DB_URL="${SUPABASE_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
SUPABASE_API_URL="http://127.0.0.1:54321"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[1;34m'
NC='\033[0m'

SEED_ONLY=false
CHECK_ONLY=false
RESET=false
ERRORS=0

usage() {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

log()  { echo -e "${BLUE}==>${NC} $*"; }
ok()   { echo -e "${GREEN}  ✓${NC} $*"; }
warn() { echo -e "${YELLOW}  !${NC} $*"; }
fail() { echo -e "${RED}  ✗${NC} $*"; ERRORS=$((ERRORS + 1)); }

for arg in "$@"; do
  case "$arg" in
    --seed-only) SEED_ONLY=true ;;
    --check)     CHECK_ONLY=true ;;
    --reset)     RESET=true ;;
    --help|-h)   usage ;;
    *) echo "Unknown option: $arg" >&2; usage ;;
  esac
done

# ── Preflight ───────────────────────────────────────────────────────────────
# Every tool is checked before any is used, so a contributor sees the full list
# of what to install instead of discovering it one failed command at a time.
require() {
  local name="$1" cmd="$2" hint="$3"
  if command -v "$cmd" &>/dev/null; then
    ok "$name found ($($cmd --version 2>/dev/null | head -1))"
  else
    fail "$name not found. $hint"
  fi
}

preflight() {
  log "Checking the local toolchain"
  require "Supabase CLI" supabase   "Install with: npm i -g supabase (https://supabase.com/docs/guides/cli)"
  require "psql"        psql       "Install with: brew install postgresql"
  require "redis-cli"   redis-cli  "Install with: brew install redis"
}

# ── Supabase ────────────────────────────────────────────────────────────────
# The CLI is only ever pointed at the local stack. `supabase start` runs the
# whole stack in Docker on 127.0.0.1 and never contacts a hosted project.
start_supabase() {
  log "Starting the local Supabase stack"
  if supabase status >/dev/null 2>&1; then
    ok "Supabase is already running"
    return 0
  fi
  if ! supabase start >/dev/null 2>&1; then
    fail "supabase start failed. Run 'supabase start' in $REPO_ROOT/app/backend to see the error."
    return 1
  fi
  ok "Supabase started"
}

wait_for_supabase() {
  log "Waiting for Postgres on 127.0.0.1:54322"
  for _ in $(seq 1 60); do
    if psql "$SUPABASE_DB_URL" -c 'SELECT 1' >/dev/null 2>&1; then
      ok "Postgres is accepting connections"
      return 0
    fi
    sleep 1
  done
  fail "Postgres did not become ready within 60s"
  return 1
}

# ── Redis ───────────────────────────────────────────────────────────────────
wait_for_redis() {
  log "Waiting for Redis"
  for _ in $(seq 1 30); do
    if redis-cli -u "$REDIS_URL" ping 2>/dev/null | grep -q PONG; then
      ok "Redis responded to PING"
      return 0
    fi
    sleep 1
  done
  # Redis is optional by design: env.schema.ts documents that omitting REDIS_URL
  # falls back to in-memory behaviour, so this is a warning, not an error.
  warn "Redis did not respond. The backend degrades to in-memory caching; that is supported."
  return 0
}

# ── Migrations and seed ─────────────────────────────────────────────────────
run_migrations() {
  log "Applying migrations"
  # The migration runner is the owning module's, not a reimplementation.
  if [ -f "$REPO_ROOT/app/backend/run-migration-supabase.js" ]; then
    if (cd "$REPO_ROOT/app/backend" && node run-migration-supabase.js); then
      ok "Migrations applied"
    else
      fail "Migrations failed. Run 'cd app/backend && node run-migration-supabase.js' to see the error."
      return 1
    fi
  else
    warn "Migration runner not found; assuming the local schema is already current."
  fi
}

apply_seed() {
  log "Applying seed fixtures"
  # The SQL carries its own database-name guard, so a misdirected SUPABASE_DB_URL
  # aborts inside the transaction rather than writing anywhere unexpected.
  if psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$SCRIPT_DIR/seed.sql"; then
    ok "Seed fixtures applied (idempotent; safe to re-run)"
  else
    fail "Seed failed. See the error above; the transaction was rolled back."
    return 1
  fi
}

reset_local() {
  # Refuse to reset anything that is not loopback: a stray DATABASE_URL must
  # never turn a local convenience script into a data-loss tool.
  local host
  host="$(printf '%s' "$SUPABASE_DB_URL" | sed -E 's#.*@([^:/]+).*#\1#')"
  case "$host" in
    127.0.0.1|localhost|::1|host.docker.internal) ;;
    *) fail "--reset refused: '$host' is not a loopback host."; return 1 ;;
  esac
  log "Resetting the local public schema on $host"
  if psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
      -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null; then
    ok "Local schema dropped and recreated"
  else
    fail "Reset failed"
    return 1
  fi
}

verify() {
  log "Verifying the local stack"
  if psql "$SUPABASE_DB_URL" -c '\dt' >/dev/null 2>&1; then
    ok "Schema reachable"
  else
    fail "Schema not reachable at $SUPABASE_DB_URL"
  fi
  if redis-cli -u "$REDIS_URL" ping 2>/dev/null | grep -q PONG; then
    ok "Redis reachable"
  else
    warn "Redis unreachable (in-memory fallback will be used)"
  fi
}

summary() {
  echo
  echo -e "${GREEN}Local stack is ready.${NC}"
  echo "Export these before starting the backend:"
  echo "  export SUPABASE_URL=$SUPABASE_API_URL"
  echo "  export SUPABASE_ANON_KEY=\$(supabase status -o env | grep ANON | cut -d= -f2-)"
  echo "  export REDIS_URL=$REDIS_URL"
  echo
  echo "Seeded: 2 verified assets, 3 usernames, 2 payment links (one already"
  echo "expired), 2 notification preferences. All synthetic; no private keys."
}


# ── Main ────────────────────────────────────────────────────────────────────
main() {
  if [ "$CHECK_ONLY" = true ]; then
    preflight
    verify
    if [ "$ERRORS" -eq 0 ]; then
      echo -e "\n${GREEN}bootstrap check: PASS${NC}"
    else
      echo -e "\n${RED}bootstrap check: FAIL ($ERRORS)${NC}"
      exit 1
    fi
    exit 0
  fi

  preflight
  # Report every missing tool in one pass rather than making the contributor
  # install them one run at a time.
  if [ "$ERRORS" -gt 0 ]; then
    echo
    fail "$ERRORS required tool(s) missing. Install the tools listed above and re-run."
    exit 1
  fi

  if [ "$RESET" = true ]; then
    reset_local || exit 1
  fi

  if [ "$SEED_ONLY" = true ]; then
    wait_for_supabase || exit 1
  else
    start_supabase || exit 1
    wait_for_supabase || exit 1
    wait_for_redis
  fi

  run_migrations || exit 1
  apply_seed  || exit 1
  verify
  summary

  [ "$ERRORS" -eq 0 ] || exit 1
}

main
