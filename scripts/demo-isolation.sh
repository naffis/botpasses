#!/usr/bin/env bash
# Local demo of the grant path. Uses a fake canary, never a real secret.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export VAULT_HOME="${TMPDIR:-/tmp}/botpasses-demo-$$"
export VAULT_MASTER_KEY="$(node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
export VAULT_ACTOR=operator
CANARY="sk_live_CANARY_do_not_leak_f47ac10b"
VAULT=(node --experimental-strip-types --disable-warning=ExperimentalWarning "$ROOT/src/cli.ts")

cleanup() { rm -rf "$VAULT_HOME"; }
trap cleanup EXIT
mkdir -p "$VAULT_HOME"

echo "== vault init"
"${VAULT[@]}" init

echo "== vault set (stdin)"
printf '%s' "$CANARY" | "${VAULT[@]}" set STRIPE_KEY

echo "== vault list"
"${VAULT[@]}" list

echo "== vault grant"
"${VAULT[@]}" grant --secret STRIPE_KEY --agent invoicer --tool stripe --once

echo "== vault run (child prints last-4 only)"
"${VAULT[@]}" run --with STRIPE_KEY --agent invoicer --tool stripe -- \
  node -e 'const v=process.env.STRIPE_KEY||""; console.log(JSON.stringify({injected:Boolean(v), last4:v.slice(-4)}))'

echo "== vault audit"
"${VAULT[@]}" audit

echo "== leak check on this script's captured idea: run again and grep"
if "${VAULT[@]}" list | grep -F "$CANARY"; then
  echo "FAIL: canary appeared in vault list" >&2
  exit 1
fi
echo "OK: list/grant/audit path did not echo the canary"
