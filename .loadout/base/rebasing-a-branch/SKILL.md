---
name: rebasing-a-branch
description: Safely rebase a branch onto its base with semantic conflict review. Use when a branch is behind and needs to catch up before merge.
---

# Rebasing a branch

## Trigger

A feature branch has diverged from its base and needs to be updated before merging.

## Workflow

1. **Back up:** note the current SHA (`git rev-parse HEAD`) so you can recover.
2. **Update base:** `git fetch origin && git rebase origin/<base>`.
3. **Resolve conflicts semantically**, not mechanically: understand both sides' intent. For lockfiles, regenerate (see `lockfile-conflicts`); never hand-merge them.
4. **After each resolution**, re-read the combined result for correctness, then `git rebase --continue`.
5. **Validate:** run the build and the affected tests on the rebased branch.
6. **Push** with lease, never a plain force: `git push --force-with-lease`.

## Guardrails

- Only force-push your own feature branch, never a shared/integration branch.
- If a rebase gets confusing, `git rebase --abort` and reassess rather than guessing through conflicts.
- Only run these git operations when that's the explicit task.

## Pairs with

- rules: `lockfile-conflicts`, `testing-conventions`
- skills: `reviewing-and-shipping`
- workflows: `clear-the-queue`
