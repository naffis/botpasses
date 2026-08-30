---
name: committing-on-shared-trunk
description: >-
  Commit (and optionally push) the entire shared working tree on the integration trunk
  without branches, stashes, or session-scoped staging. Use when the user asks to commit,
  commit and push, or land changes — and whenever multiple agents may have dirty files in
  the same checkout under shared-working-tree / no-stash.
---

# Committing on shared trunk

## Trigger

User explicitly asked to commit and/or push. Multiple agents may have left WIP in this
tree. Load this skill before any `git add` / `git commit`.

## Preconditions

1. Confirm the user message authorizes commit (and push if pushing). If not → stop.
2. Resolve the trunk branch from `AGENTS.md` (fallback: current branch if it is already
   the project's integration branch). If on another branch and the user did not ask for
   that branch → stop and ask; do not create a new branch.
3. **Never** run `git stash` (any form) or create a branch/worktree to proceed.

## Workflow

Copy and track:

```
Commit Progress:
- [ ] Inventory full working tree
- [ ] Secret scan
- [ ] Stage ALL eligible files
- [ ] Message covers whole tree
- [ ] Commit
- [ ] Pull without stash (if pushing)
- [ ] Push (only if asked)
- [ ] Verify clean tree (ignored files OK)
```

### 1. Inventory the full tree

```bash
git status
git diff
git diff --stat
git status -u
```

List **every** modified and untracked path. Do not filter to "files I touched this
session." Other agents' work is in scope.

If anything looks half-written, has conflict markers, or is clearly an in-progress edit
you should not land → **stop and ask**. Leave the tree untouched.

### 2. Secret scan

Refuse to stage secrets / PII: `.env`, `.env.*` (except committed examples like
`.env.example`), credential JSON, key files, etc. If a secret is dirty:

- Leave it unstaged / ensure it stays gitignored.
- Warn the user.
- Continue with everything else only if the remainder is safe.

`.gitignore` is the boundary — `git add -A` will not add ignored files.

### 3. Stage everything eligible

```bash
git add -A
git status
git diff --staged --stat
```

**Do not** selectively unstage "other agents' files" or "unrelated plans." Commit-all is
the policy. The only deliberate exclusions are secrets and paths the user named to skip.

### 4. Write the message for the whole tree

Read the **full** staged diff. Draft `type(scope): summary` that covers the combined
change. If multiple themes are present (common with parallel agents):

- Pick the primary type/scope from the dominant theme.
- Put other themes in the commit body as bullets — do not omit them from the message.
- Prefer one commit of the whole tree over leaving WIP behind. Split into multiple
  commits only if the user explicitly asks to split.

### 5. Commit

```bash
git commit -m "$(cat <<'EOF'
type(scope): summary

Optional body covering all themes / agents' work.

EOF
)"
git status
```

If a hook rejects the commit: fix the issue, stage the fix with the rest (still whole
tree), create a **new** commit — do not amend unless amend rules all pass.

### 6. Pull / push (only if asked to push)

Commit-first so the shared dirty tree is never stashed. Replace `<trunk>` with the
integration branch from `AGENTS.md`:

```bash
git pull --ff-only origin <trunk>
# If ff-only fails because of divergence after commit:
#   git pull --rebase origin <trunk>
# If that still fails: STOP and ask. Never stash.
git push origin <trunk>
```

Wait for CI/staging green when the project's workflow requires it.

### 7. Done check

`git status` should show a clean work tree (ignored files may remain). Report the commit
SHA and that **all** previously dirty eligible files were included.

## Anti-patterns

| Anti-pattern | Do instead |
| --- | --- |
| `git add path/only/mine` | `git add -A` |
| `git stash` then pull | Commit all first, then pull |
| `git checkout -b …` for this commit | Stay on trunk |
| Message that ignores other agents' files | Body lists every theme staged |
| "Focused commit" leaving sibling WIP | Land the whole tree |
| Open a PR because a skill mentioned PRs | Push trunk unless user asked for a PR |

## Pairs with

- rules: `git-safety`, `shared-working-tree`, `no-stash`, `commit-and-pr-conventions`
- skills: `writing-commit-messages` (message shape only; scope = whole tree here),
  `reviewing-and-shipping`
- workflows: `ship-a-feature`, `plan-then-build`, `clear-the-queue`
