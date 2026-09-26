#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# verify-devcontainer.sh – Verify devcontainer toolchain provisioning
# Validates Node.js, pnpm, Rust, wasm32 Soroban target, and Stellar CLI.
# ─────────────────────────────────────────────────────────────────────────────
set -eo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

STRICT=false
ERRORS=0
if [[ "${1:-}" == "--strict" ]]; then
  STRICT=true
fi

check_cmd() {
  local name="$1"
  local cmd="$2"
  local required="${3:-true}"

  if ! command -v "$cmd" &>/dev/null; then
    if [ "$required" = "true" ] || [ "$STRICT" = "true" ]; then
      echo -e "${RED}[FAIL]${NC} $name ($cmd) is NOT installed or not on PATH."
      ERRORS=$((ERRORS + 1))
      return 1
    else
      echo -e "${YELLOW}[WARN]${NC} $name ($cmd) is not installed."
      return 0
    fi
  fi

  local version
  version=$("$cmd" --version 2>&1 | head -n 1)
  echo -e "${GREEN}[OK]${NC} $name is installed: $version"
  return 0
}

echo "=== QuickEx DevContainer Toolchain Verification ==="

check_cmd "Node.js" "node" "true"
check_cmd "pnpm" "pnpm" "true"
check_cmd "Rust Compiler (rustc)" "rustc" "false"
check_cmd "Cargo" "cargo" "false"

# Check wasm32-unknown-unknown target if rustup is available
if command -v rustup &>/dev/null; then
  if rustup target list --installed | grep -q "wasm32-unknown-unknown"; then
    echo -e "${GREEN}[OK]${NC} Rust wasm32-unknown-unknown target is installed."
  else
    echo -e "${RED}[FAIL]${NC} Rust wasm32-unknown-unknown target is missing. Run: rustup target add wasm32-unknown-unknown"
    ERRORS=$((ERRORS + 1))
  fi
fi

# Check Stellar / Soroban CLI
if command -v stellar &>/dev/null; then
  STELLAR_VER=$(stellar --version 2>&1 | head -n 1)
  echo -e "${GREEN}[OK]${NC} Stellar CLI is installed: $STELLAR_VER"
elif command -v soroban &>/dev/null; then
  SOROBAN_VER=$(soroban --version 2>&1 | head -n 1)
  echo -e "${GREEN}[OK]${NC} Soroban CLI is installed: $SOROBAN_VER"
else
  echo -e "${YELLOW}[WARN]${NC} Neither 'stellar' nor 'soroban' CLI found on PATH."
fi

echo "==================================================="
if [ $ERRORS -gt 0 ]; then
  echo -e "${RED}DevContainer verification finished with $ERRORS error(s).${NC}"
  exit 1
else
  echo -e "${GREEN}DevContainer verification passed successfully!${NC}"
  exit 0
fi
