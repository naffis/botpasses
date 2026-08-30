---
name: fix-ci-until-green
uses:
  rules: [no-shortcuts, regression-test]
  skills: [fixing-ci, triaging-flaky-tests, debugging-an-issue]
  agents: [ci-watcher]
gate: "gh pr checks (all required checks pass)"
stop_condition: "all required PR checks are green"
state: ".loadout/state/fix-ci.md"
---

# Fix CI until green

For a staging/production failure that is not a PR check — especially with no local repro —
use `debug-production` (and `hotfix-and-rollback` if service is down) instead of this
workflow.

1. **Watch** — `ci-watcher` agent reports failing checks with links and a category guess.
2. **Classify & fix** — `fixing-ci`: env/infra → retry or escalate; flake → `triaging-flaky-tests`; real → reproduce locally and fix the root cause (`debugging-an-issue`).
3. **Re-run** the exact failing command locally, then push.
4. **Loop** until the `gate` holds. Never disable a test to get green.

Run the fix cycle as a verified loop (`agentic-loop`) with a hard iteration budget. Hand-off: ci-watcher surfaces failures; fixing-ci routes each to the right skill; the state file tracks which checks remain.
