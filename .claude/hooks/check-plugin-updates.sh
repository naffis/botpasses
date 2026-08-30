#!/usr/bin/env bash
# loadout SessionStart notify hook.
#
# Purpose: once per day, tell the user when an installed loadout plugin is behind
# the marketplace remote. It NOTIFIES ONLY. It never runs `/plugin update` itself,
# because SessionStart fires before plugin version resolution, so an in-hook update
# would not take effect until the next relaunch anyway.
#
# Installed by `loadout init` and wired into .claude/settings.json:
#
#   {
#     "hooks": {
#       "SessionStart": [
#         { "hooks": [ { "type": "command",
#           "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/check-plugin-updates.sh",
#           "timeout": 15 } ] }
#       ]
#     }
#   }
#
# Configuration (optional env vars):
#   LOADOUT_MARKETPLACE   git remote of the marketplace (default: https://github.com/naffis/loadout.git)
#   LOADOUT_BRANCH        branch to compare against (default: main)
#   LOADOUT_CACHE_DIR     where the throttle timestamp lives (default: project .claude/.cache)

set -euo pipefail

MARKETPLACE_REMOTE="${LOADOUT_MARKETPLACE:-https://github.com/naffis/loadout.git}"
BRANCH="${LOADOUT_BRANCH:-main}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CACHE_DIR="${LOADOUT_CACHE_DIR:-$PROJECT_DIR/.claude/.cache}"
STAMP="$CACHE_DIR/loadout-update-check"
LOCK="$PROJECT_DIR/loadout.lock.json"

# --- throttle: at most once per 24h ---------------------------------------
now="$(date +%s)"
if [[ -f "$STAMP" ]]; then
  last="$(cat "$STAMP" 2>/dev/null || echo 0)"
  if (( now - last < 86400 )); then
    exit 0
  fi
fi
mkdir -p "$CACHE_DIR"
echo "$now" > "$STAMP"

# --- resolve remote HEAD ----------------------------------------------------
# git ls-remote works without a full clone and is cheap.
remote_sha="$(git ls-remote "$MARKETPLACE_REMOTE" "refs/heads/$BRANCH" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
if [[ -z "$remote_sha" ]]; then
  # Network or auth issue: stay silent, this is a best-effort notice.
  exit 0
fi

# --- resolve what we have installed ----------------------------------------
# Prefer the ref recorded in the lockfile; fall back to "unknown".
local_ref="unknown"
if [[ -f "$LOCK" ]] && command -v node >/dev/null 2>&1; then
  local_ref="$(node -e 'try{const l=require(process.argv[1]);process.stdout.write(l.ref||"unknown")}catch(e){process.stdout.write("unknown")}' "$LOCK" 2>/dev/null || echo unknown)"
fi

# If the lockfile pins a tag/ref, resolve its SHA on the remote for comparison.
pinned_sha=""
if [[ "$local_ref" != "unknown" && -n "$local_ref" ]]; then
  pinned_sha="$(git ls-remote "$MARKETPLACE_REMOTE" "refs/tags/$local_ref" "refs/heads/$local_ref" 2>/dev/null | awk '{print $1}' | head -n1 || true)"
fi

if [[ -n "$pinned_sha" && "$pinned_sha" == "$remote_sha" ]]; then
  exit 0
fi

# --- count how far behind (best-effort) ------------------------------------
behind_note=""
if [[ -n "$pinned_sha" ]]; then
  behind_note=" (pinned ${local_ref})"
fi

cat <<EOF
[loadout] The loadout marketplace has new commits on ${BRANCH}${behind_note}.
[loadout] Update your plugins:
[loadout]   /plugin marketplace update
[loadout]   /plugin update <plugin-name>
[loadout] Or pull vendored assets:  npx github:naffis/loadout update --check
[loadout] Or ask the agent: "update loadout to latest" (INSTALL.md Flow B / equipping-loadout)
EOF

exit 0
