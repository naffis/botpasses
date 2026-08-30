# Implement-node dispatch prompt

Sub-agents do **not** see the orchestrator conversation. Every `implement-node`
launch must be self-contained. Copy, fill, send (Cursor `Task` /
`generalPurpose` or "use the `implement-node` subagent").

## Template

```text
You are the implement-node worker for unit <U-0N> only.

TASK file (absolute): <path>/.loadout/tasks/<slug>/TASK.md
Unit id: <U-0N>
Shared contract (read-only): <path>/.loadout/tasks/<slug>/contract.<ext>
Isolation: shared trunk at <absolute-cwd>  OR  worktree at <absolute-path>
  (If shared trunk: no stash, no new branch/worktree. Edits unstaged.)

Read ONLY your unit entry in the TASK file + the contract file + files inside
your allowlist. Follow rules/implement-node.mdc exactly.

Hard rules:
- Edit only your file allowlist. Contract is read-only.
- No cross-unit communication. Missing interface → Status FAILED → decompose.
- Run YOUR verifier from the TASK file before finishing.
- Terminal state is PASSED or FAILED only — never done-with-caveats.
- Do not commit, push, PR, merge, or stash unless this message explicitly says so
  (default: do not).

Return exactly:

Unit: <U-0N>
Status: PASSED | FAILED
Allowlist: clean | breached (<paths>)
Verifier: `<command>` → pass | fail
Evidence: <key output>
Contract gaps: none | <what belongs in decompose>
```

## Orchestrator checklist before launch

- [ ] `decompose` finished; contract file exists; unit has allowlist + verifier
- [ ] Graph: allowlists pairwise disjoint (re-check). Pipeline: merge/exec order set
- [ ] Isolation mode matches TASK.md (`shared-working-tree` wins unless user asked)
- [ ] Concurrency: graph waves of ≤3; pipeline = one unit at a time
- [ ] Full-suite verifier named (for `integrate` later) — not required green yet

## After each unit returns

1. If FAILED → do not integrate; either re-dispatch with the failure, or fail back to
   `decompose` / `task-topology`.
2. If PASSED → record evidence in TASK.md status; wait for siblings (graph) or
   start the next stage (pipeline).
3. When the wave/stage set is ready → `integrate`.
