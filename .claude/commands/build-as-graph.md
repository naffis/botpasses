---
description: Structure one nontrivial task as single-loop, pipeline, or verified graph (task-topology → decompose → implement-node → integrate).
---

Everything after this command is the task. Run the `build-as-graph` workflow in full
(skills: `task-topology`, then `decompose` / `implement-node` / `integrate` as the
topology requires).

## Ground rules

- Default is **single-loop**. Escalate to pipeline/graph only when `task-topology`'s
  escalation tests pass. A graph of unverified agents is worse than one loop.
- Always write `.loadout/tasks/<slug>/TASK.md`.
- Honor `shared-working-tree` / `no-stash` / `git-safety` when installed — no ad-hoc
  worktrees unless the user asks.
- Graph concurrency ≤3. Pipeline is serial. Integrate runs the **full-suite** verifier
  after each accept; re-dispatch contract violators — do not hand-fix across boundaries.
- Do not commit/push/PR unless the user explicitly asks.
- Not for a queue of independent tickets → use `clear-the-queue` instead.

Task: $ARGUMENTS
