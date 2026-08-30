---
name: opening-a-pr
description: Create a branch, push, and open a pull request with a validation-first description. Use only when the user explicitly asks to open a PR or create a review branch.
---

# Opening a PR

## Trigger

**Only** when the user explicitly asks to open a PR (or create a review branch). If
`shared-working-tree` is installed, the default ship path is whole-tree commit + push to
trunk (`committing-on-shared-trunk`) — do **not** enter this skill for "commit and push",
"ship", "finish the ticket", or review-build.

## Workflow

1. **Branch.** From an up-to-date base, create a branch **because the user asked for a
   PR/branch**. Use the ticket's generated branch name if one exists.

```bash
git checkout <base> && git pull
git checkout -b <branch>
```

2. **Do the work** (see `planning-a-change`), committing as authorized.
3. **Push** with upstream tracking: `git push -u origin HEAD`.
4. **Open the PR** targeting the integration branch (not production). Body = summary + why + concrete "Verify that…" steps + screenshots for UI + migration/flag/rollback notes. Reference the ticket ("Fixes PROJ-142").

```bash
gh pr create --title "..." --body "$(cat <<'EOF'
## Summary
...
## Test plan
- [ ] Verify that ...
EOF
)"
```

## Guardrails

- PRs target the integration branch; never open directly against production.
- Don't self-merge or mark the ticket done unless that's the workflow.
- Never stash to create a clean branch point (`no-stash`) — commit on trunk first or ask.
- If the user did not ask for a PR and `shared-working-tree` is installed, use
  `committing-on-shared-trunk` instead.

## Pairs with

- rules: `commit-and-pr-conventions`, `git-safety`, `shared-working-tree`, `no-stash`
- skills: `writing-commit-messages`, `committing-on-shared-trunk`, `making-a-pr-reviewable`
- workflows: `ship-a-feature`, `plan-then-build`, `clear-the-queue`
