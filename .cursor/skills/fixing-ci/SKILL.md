---
name: fixing-ci
description: Find failing CI checks, classify the cause, and apply focused fixes. Use when a PR's checks are red or a build is failing.
---

# Fixing CI

## Trigger

CI checks are failing on a branch or PR.

## Workflow

1. **List the failing checks** and open the logs.

```bash
gh pr checks --json name,bucket,state,workflow,link
gh run view <run-id> --log-failed
```

2. **Classify each failure:**
   - **env/infra** (missing secret, runner, flaky network) → not your code; retry or escalate, don't "fix" code.
   - **flake** (passes on clean re-run, unrelated) → see `triaging-flaky-tests`; file it, don't paper over.
   - **real** (deterministic, tied to the diff) → reproduce locally, fix the root cause.
3. **Reproduce locally** with the same command CI runs. Fix, then re-run that exact command.
4. **Push and watch** the checks go green; iterate if needed.

## Guardrails

- Never disable, skip, or delete a failing test to get green. Fix it or escalate.
- Fix causes, not symptoms; don't loosen lint/types to silence errors.

## Pairs with

- rules: `no-shortcuts`, `regression-test`
- skills: `triaging-flaky-tests`, `debugging-an-issue`
- agents: `ci-watcher`
- workflows: `fix-ci-until-green`, `dependency-bump`
