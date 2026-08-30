# What "this session" means

## Table of Contents

- [Definition](#definition)
- [Reconstruct before inventory](#reconstruct-before-inventory)
- [Path union](#path-union)
- [Empty inventory is not CLEAN](#empty-inventory-is-not-clean)
- [Shared dirty tree](#shared-dirty-tree)
- [Resume](#resume)

## Definition

**This session = this conversation's work**, not "whatever is dirty" and not
"since the last push."

Include:

1. Every user message that added or changed scope (verbatim).
2. Every feature / function those messages imply — even with no new file
   (empty state, bind rule, flag default, error copy).
3. Files this conversation created or edited (your own tool traces, not
   memory of intent).
4. The dirty tree **attributed to this chat**.
5. Commits this chat made (`git log` / `--since <ref>`). Mid-session
   commit must not hide the work from inventory.

Exclude sibling-agent WIP on a shared trunk unless the user said to
verify the whole tree.

## Reconstruct before inventory

Do this **before** running the script:

1. Quote the asks. Number implied deliverables (surfaces + functions).
2. List files you actually wrote or patched this chat.
3. `git status --porcelain` + `git diff --stat` + `git diff --stat --staged`.
4. If the tree is clean (or thinner than the work you remember doing),
   you committed or the work is elsewhere — do **not** stop. Set
   `--since` to the integration trunk in `AGENTS.md` (often `origin/dev`)
   **or** the SHA from before this chat, and/or pass explicit paths.

An agent that inventories only `git status` after a commit will report
zero surfaces and fake CLEAN. That is a failed run.

## Path union

```text
session paths = conversation-edited
              ∪ dirty (unstaged + staged + untracked)
              ∪ (--since <ref> when commits are in play)
              ∪ extra paths the user named
```

Then collapse to surfaces (`surface-matrix.md`) and **UNION** the
ask-implied functions that have no file.

```bash
# Dirty + untracked only (default)
session-inventory.sh

# Committed mid-session or clean tree after commit
session-inventory.sh --since origin/dev

# Shared trunk: this chat's paths only
session-inventory.sh path/a path/b
```

Consumer path: `.cursor/skills/verifying-session-surfaces/scripts/session-inventory.sh`
(Claude Code plugin: the skill folder's `scripts/session-inventory.sh`).

## Empty inventory is not CLEAN

| RECEIPT files | Asks imply surfaces | Action                                                                                            |
| ------------- | ------------------- | ------------------------------------------------------------------------------------------------- |
| 0             | no                  | Reconstruct again. If still nothing, verdict **N/A — no session work**, not CLEAN.                |
| 0             | yes                 | Build the matrix from asks + conversation files. Passing `--since` or explicit paths is required. |
| >0            | yes                 | UNION both. A file-less feature with no matrix row is a miss.                                     |

`flight-checker` treats empty RECEIPT + CLEAN as FAIL unless the report
shows the reconstruction and a justified N/A.

## Shared dirty tree

If `git status` shows files you did not touch: pass explicit paths or
ask. Do not exercise or "fix" a sibling's WIP. `--since origin/dev` on a
shared trunk will include other agents — do not use it as a substitute
for path args.

## Resume

If this chat already has a matrix (or `_local/session-surfaces-STATE.md`):

- Do not re-prove `WORKS` rows unless their files changed again.
- Re-exercise `BROKEN` / `BLOCKED` and any new ask or new file.
- Keep the matrix append-only; flip verdicts in place.
