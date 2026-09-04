#!/usr/bin/env bash
# Runs `npm audit` for runtime dependencies with a bounded fetch timeout and retries.
# The registry's bulk advisory endpoint sometimes hangs for minutes and the fallback
# "quick" endpoint then answers 400; neither says anything about the lockfile. A real
# advisory still fails every attempt and so fails the step.
#
# Usage: scripts/audit.sh [npm --prefix args...]   e.g. scripts/audit.sh --prefix site
set -u
attempts="${AUDIT_ATTEMPTS:-3}"
for attempt in $(seq 1 "$attempts"); do
  if npm "$@" audit --omit=dev --audit-level=high --fetch-timeout=120000 --fetch-retries=2; then
    exit 0
  fi
  status=$?
  if [ "$attempt" -lt "$attempts" ]; then
    echo "npm audit attempt $attempt failed (exit $status); retrying in 20s" >&2
    sleep 20
  fi
done
echo "npm audit failed after $attempts attempts" >&2
exit 1
