#!/usr/bin/env bash
# Session file inventory + coarse surface labels. Quote RECEIPT in the report.
# Usage:
#   session-inventory.sh                         # dirty vs HEAD + untracked
#   session-inventory.sh --since <ref>           # that plus files changed since ref
#   session-inventory.sh [--since <ref>] <path>  # explicit paths (UNION since)
# Compatible with macOS bash 3.2 (no mapfile). Paths may contain spaces.
set -eu

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

SINCE=""
PATH_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --since)
      shift
      SINCE="${1:-}"
      [[ -n "$SINCE" ]] || { echo "session-inventory: --since needs a ref" >&2; exit 2; }
      shift
      ;;
    --since=*)
      SINCE="${1#--since=}"
      shift
      ;;
    --)
      shift
      while [[ $# -gt 0 ]]; do
        PATH_ARGS+=("$1")
        shift
      done
      break
      ;;
    -*)
      echo "session-inventory: unknown flag $1" >&2
      exit 2
      ;;
    *)
      PATH_ARGS+=("$1")
      shift
      ;;
  esac
done

emit_nul_paths() {
  if [[ ${#PATH_ARGS[@]} -gt 0 ]]; then
    local p
    for p in "${PATH_ARGS[@]}"; do
      printf '%s\0' "$p"
    done
  fi
  if [[ ${#PATH_ARGS[@]} -eq 0 || -n "$SINCE" ]]; then
    # Unstaged + staged vs HEAD
    git diff -z --name-only HEAD 2>/dev/null || true
    git ls-files -z --others --exclude-standard 2>/dev/null || true
  fi
  if [[ -n "$SINCE" ]]; then
    git diff -z --name-only "$SINCE" 2>/dev/null || true
  fi
}

classify() {
  local p="$1"
  case "$p" in
    *.test.ts|*.test.tsx|*.test.js|*.test.mjs|*.test.cjs|*.spec.ts|*.spec.tsx|*.spec.js|*.e2e.ts|*.e2e.tsx|*.cy.ts|*.cy.js|*playwright*|*_test.go|*_test.py|*.test.py)
      echo test
      return
      ;;
  esac
  case "$p" in
    *.md|docs/*|*/docs/*)
      echo docs
      return
      ;;
  esac
  case "$p" in
    */migrations/*|*/schema/*|*migration*)
      echo schema
      return
      ;;
  esac
  case "$p" in
    *feature-flag*|*feature_flag*|*/feature-flags.md)
      echo flag
      return
      ;;
  esac
  case "$p" in
    */mcp/*)
      echo mcp
      return
      ;;
  esac
  case "$p" in
    */cli/*|*/bin/*)
      echo cli
      return
      ;;
  esac
  case "$p" in
    *inngest*|*/cron/*)
      echo job
      return
      ;;
  esac
  case "$p" in
    *sse*|*websocket*|*web-socket*|*ws-ticket*|*event-source*)
      echo realtime
      return
      ;;
  esac
  case "$p" in
    *.tsx|*.jsx|*.vue|*.svelte|*.astro|*/components/*|*/pages/*|*/islands/*)
      echo ui
      return
      ;;
  esac
  case "$p" in
    *openapi*|*/http/*|*/api/*|*routes*|*route*)
      echo api
      return
      ;;
  esac
  echo code
}

# Dedup NUL records (macOS sort -z). Then read as lines for classify.
PATHS=""
while IFS= read -r -d '' p; do
  [[ -z "$p" ]] && continue
  PATHS="${PATHS}${p}"$'\n'
done < <(emit_nul_paths | sort -z -u)

FILE_COUNT=0
ui=0
api=0
mcp=0
cli=0
job=0
realtime=0
flag=0
schema=0
test=0
docs=0
code=0

echo "RECEIPT"
if [[ -n "$SINCE" ]]; then
  echo "since: ${SINCE}"
fi
if [[ ${#PATH_ARGS[@]} -gt 0 ]]; then
  echo "explicit_paths: ${#PATH_ARGS[@]}"
fi
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  FILE_COUNT=$((FILE_COUNT + 1))
  kind="$(classify "$p")"
  echo "file: ${p}  kind: ${kind}"
  case "$kind" in
    ui) ui=$((ui + 1)) ;;
    api) api=$((api + 1)) ;;
    mcp) mcp=$((mcp + 1)) ;;
    cli) cli=$((cli + 1)) ;;
    job) job=$((job + 1)) ;;
    realtime) realtime=$((realtime + 1)) ;;
    flag) flag=$((flag + 1)) ;;
    schema) schema=$((schema + 1)) ;;
    test) test=$((test + 1)) ;;
    docs) docs=$((docs + 1)) ;;
    *) code=$((code + 1)) ;;
  esac
done <<< "$PATHS"

echo "files: ${FILE_COUNT}"
echo "kind_counts: ui=${ui} api=${api} mcp=${mcp} cli=${cli} job=${job} realtime=${realtime} flag=${flag} schema=${schema} test=${test} docs=${docs} code=${code}"
if [[ "$FILE_COUNT" -eq 0 ]]; then
  echo "note: no paths — reconstruct session (session-scope.md); try --since <ref> or explicit paths. Not CLEAN."
fi
echo "END"
exit 0
