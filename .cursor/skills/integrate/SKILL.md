---
name: integrate
description: >
  Fan-in work units after parallel or pipelined implement-node runs: merge in declared
  order, run the full verifier suite after each merge, re-dispatch contract violators
  instead of hand-fixing across boundaries, and close with a spec review for divergent
  interface interpretations. Use when units report done, or when asked to "integrate
  units", "merge the graph", or "fan-in the task". Anti-triggers: units still implementing
  → wait; topology/decompose incomplete → task-topology / decompose; single-loop task →
  no integrate; multi-ticket landing → orchestrating-parallel-agents.
---

# Integrate

The fan-in for a pipeline or graph. You are the integrator, not a second implementer of
every unit. On conflict or cross-unit failure: identify which unit violated the contract
and **re-dispatch that unit** — never hand-fix across boundaries in this context.

## Trigger

- One or more `implement-node` units report `PASSED` and are ready to land into the
  integration tree.
- User asks to merge/fan-in a task graph.

Requires `.loadout/tasks/<slug>/TASK.md` with units, merge order, and a full-suite
verifier. If the full-suite verifier is missing, **stop** — verifier-first; a green
fan-in without a suite is theater.

## Isolation mode (honor existing rules)

| Mode | When | How to merge |
| --- | --- | --- |
| **shared-trunk** | `shared-working-tree` installed, or units already edited the same checkout with disjoint allowlists | Units may already share the working tree. Accept in **merge order**: verify allowlist via `git diff`, run **full-suite** verifier, mark `integrated`, then accept the next. No stash. No new branches/worktrees unless the user asks. On mid-edit collision → stop, leave tree intact, ask (`shared-working-tree`). |
| **worktrees** | Shared-tree kit **not** installed, or user explicitly asked for worktrees | Merge/apply each unit's worktree in merge order onto the integration checkout; full-suite after each; remove worktree only after that unit is `integrated`. |

Do not invent worktrees to "make integrate easier" when `shared-working-tree` applies —
that silently overrides `git-safety` / `no-stash`. Flag the conflict and stay on trunk.

**Pipeline note:** stages were already serial; integrate still runs the full suite after
each stage acceptance (unit green ≠ system green).

## Workflow

### 1. Inventory

Read the task file. For each unit in **merge order**:

- Status must be `PASSED` with verifier evidence (command + outcome). `FAILED` or
  done-with-caveats → do not merge; re-dispatch or stop.
- Spot-check allowlist: `git diff` paths ⊆ unit allowlist (contract path is read-only;
  edits there outside a decompose pass fail the unit).
- Paths outside the allowlist → unit **FAILED**; re-dispatch, do not "fix in integrate."

### 2. Merge / accept one unit at a time

For each unit in order:

1. Apply/merge that unit's changes only (worktrees) **or** accept its already-present
   shared-trunk edits (after allowlist check).
2. Run the **full-suite verifier** from the task file (not only the unit verifier).
3. On green: mark unit `integrated`; proceed.
4. On red or conflict:
   - Attribute failure to a **unit + contract clause** (which symbol/invariant broke).
   - Re-dispatch **that** unit with the failure output and contract citation
     (`task-topology/references/dispatch-prompt.md`).
   - Do not patch the other unit's files here to paper over a bad interface.
   - If attribution is ambiguous because the contract is underspecified → fail back to
     `decompose` (contract edit), then re-dispatch affected units.

### 3. Final full suite

After the last merge, run the full-suite verifier again. Paste evidence.

### 4. Spec review (classic parallel failure)

Review the integrated tree against the original spec/plan, specifically hunting:

> Three units that each pass but implement three different understandings of the same
> interface.

Checks:

- Every contract symbol has one meaning at all call sites.
- Error codes / status enums agree across producers and consumers.
- Persistence shapes match what readers expect.
- Plan ACs that span units still hold end-to-end (not just per-unit).

Dispatch `reviewer` against the full diff + original acceptance contract when the change
is shippable. Prefer a fresh context (`review-build` in a new chat for high stakes).

### 5. Report

Update the task file statuses. Reply with:

| Unit | Allowlist clean | Unit verifier | Status | Full suite after accept |
| --- | --- | --- | --- | --- |
| U-01 | yes | PASSED | integrated | PASSED |

Plus: contract re-dispatch count, any decompose fallbacks, final spec-review verdict.

## Never do

- Hand-fix across unit boundaries in the integrator context.
- Skip the full suite after a merge because "the unit already passed."
- Merge a unit that touched files outside its allowlist.
- Proceed without a full-suite verifier.
- Land/commit/push unless the user explicitly asked (`commit-and-pr-conventions`).
- Override `shared-working-tree` with ad-hoc worktrees.

## Pairs with

- skills: `task-topology`, `decompose`, `review-build`, `agentic-loop`,
  `orchestrating-parallel-agents`, `rebasing-a-branch`, `committing-on-shared-trunk`
- rules: `implement-node-rule`, `shared-working-tree`, `no-stash`, `git-safety`,
  `definition-of-done`, `no-shortcuts`, `commit-and-pr-conventions`
- agents: `implement-node`, `reviewer`, `security-reviewer`
- workflows: `build-as-graph`
- refs: `../task-topology/references/dispatch-prompt.md`
- docs: `agentic-patterns`
