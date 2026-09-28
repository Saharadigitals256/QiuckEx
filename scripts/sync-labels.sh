#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# sync-labels.sh – Apply .github/labels.yml to the GitHub repository
# Usage:
#   ./scripts/sync-labels.sh              # Create/update labels (idempotent)
#   ./scripts/sync-labels.sh --check      # Report drift, make no changes
#   ./scripts/sync-labels.sh --prune      # Also delete labels not in the file
#
# The script is idempotent: running it twice produces the same result. It only
# creates or updates the labels declared in .github/labels.yml. Deletion is
# opt-in via --prune, because a label applied to an issue but missing from the
# file would otherwise be destroyed.
#
# Prerequisites:
#   gh (GitHub CLI), authenticated, with the `repo` scope
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABELS_FILE="$REPO_ROOT/.github/labels.yml"
TARGET_REPO="${QUICKEX_REPO:-Viky207/QiuckEx}"

MODE="apply"
case "${1:-}" in
  --check) MODE="check" ;;
  --prune) MODE="prune" ;;
  "")      MODE="apply" ;;
  *)       echo "Unknown option: $1" >&2; exit 2 ;;
esac

if ! command -v gh >/dev/null 2>&1; then
  echo "::error::gh (GitHub CLI) is required. See https://cli.github.com" >&2
  exit 1
fi

if [ ! -f "$LABELS_FILE" ]; then
  echo "::error::missing $LABELS_FILE" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "::error::gh is not authenticated. Run 'gh auth login'." >&2
  exit 1
fi

# Parse the flat "- name / color / description" list. The file is deliberately a
# plain sequence so it can be read here without pulling in a YAML parser.
parse_labels() {
  awk '
    function emit() {
      if (name != "") { printf "%s\t%s\t%s\n", name, color, desc }
      name=""; color=""; desc=""
    }
    /^- name:/   { emit(); name=$0; sub(/^- name:[ ]*/, "", name) }
    /^  color:/  { color=$0; sub(/^[ ]*color:[ ]*/, "", color) }
    /^  description:/ { desc=$0; sub(/^[ ]*description:[ ]*/, "", desc) }
    END { emit() }
  ' "$LABELS_FILE"
}

declare -a DESIRED=()
while IFS=$'\t' read -r lname lcolor ldesc; do
  [ -n "$lname" ] || continue
  DESIRED+=("$lname"$'\x01'"$lcolor"$'\x01'"$ldesc")
done < <(parse_labels)

if [ "${#DESIRED[@]}" -eq 0 ]; then
  echo "::error::no labels parsed from $LABELS_FILE" >&2
  exit 1
fi

echo "Target repository: $TARGET_REPO"
echo "Declared labels:   ${#DESIRED[@]}"

EXISTING="$(gh label list --repo "$TARGET_REPO" --limit 200 --json name 2>/dev/null || echo '[]')"

created=0
updated=0
unchanged=0
drift=""

for entry in "${DESIRED[@]}"; do
  name="${entry%%$'\x01'*}"
  rest="${entry#*$'\x01'}"
  color="${rest%%$'\x01'*}"
  desc="${rest#*$'\x01'}"

  if printf '%s' "$EXISTING" | grep -q "\"name\":\"$name\""; then
    if [ "$MODE" = "check" ]; then
      drift+="  exists: $name"$'\n'
    elif gh label edit "$name" --repo "$TARGET_REPO" --color "$color" --description "$desc" >/dev/null 2>&1; then
      updated=$((updated + 1))
      echo "  updated: $name"
    else
      unchanged=$((unchanged + 1))
      echo "  warn: could not update $name"
    fi
  else
    if [ "$MODE" = "check" ]; then
      drift+="  missing: $name"$'\n'
    elif gh label create "$name" --repo "$TARGET_REPO" --color "$color" --description "$desc" >/dev/null 2>&1; then
      created=$((created + 1))
      echo "  created: $name"
    else
      unchanged=$((unchanged + 1))
      echo "  warn: could not create $name"
    fi
  fi
done

if [ "$MODE" = "prune" ]; then
  # Labels present on the repo but absent from the file are only deleted when
  # --prune is passed explicitly.
  while IFS= read -r existing_name; do
    [ -n "$existing_name" ] || continue
    keep=0
    for entry in "${DESIRED[@]}"; do
      if [ "${entry%%$'\x01'*}" = "$existing_name" ]; then keep=1; break; fi
    done
    if [ "$keep" -eq 0 ] && gh label delete "$existing_name" --repo "$TARGET_REPO" >/dev/null 2>&1; then
      echo "  pruned: $existing_name"
    fi
  done < <(printf '%s' "$EXISTING" | grep -o '"name":"[^"]*"' | sed 's/"name":"//; s/"$//')
fi

case "$MODE" in
  check)
    if [ -n "$drift" ]; then
      echo "::warning::label drift detected:"
      printf '%s' "$drift"
      exit 1
    fi
    echo "Labels are in sync."
    ;;
  prune)
    echo "Done. created=$created updated=$updated unchanged=$unchanged (extras pruned)"
    ;;
  *)
    echo "Done. created=$created updated=$updated unchanged=$unchanged"
    ;;
esac
