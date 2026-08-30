---
name: task-topology
description: >
  Triage a nontrivial dev task into single-loop, pipeline, or graph topology before
  implementing. Writes a topology declaration (units, file boundaries, verifiers, merge
  order) that downstream skills treat as the contract. Use at the start of any nontrivial
  task, when choosing whether to parallelize work units, or when asked for "task topology",
  "single loop vs graph", or "how should we structure this work". Anti-triggers: one-liner
  / QUICK fix → just implement; N independent tickets → orchestrating-parallel-agents;
  already-decomposed units → decompose or implement-node.
---

# Task topology

Decide *how* this task should be built — one agent loop, a sequential pipeline, or a
verified work graph — **before** spawning workers. Default is a single loop. Escalate only
when the evidence supports it.

This skill does **not** restate `agentic-loop`, `orchestrating-parallel-agents`, or
`shared-working-tree`. It chooses among them and writes the contract those assets consume.

## Trigger

- Nontrivial task about to start (multi-file, multi-concern, or unclear fan-out).
- Plan that might need parallel units (`create-plan` topology section).
- User asks how to structure the work / whether to parallelize.

Skip for one-liners and obvious QUICK fixes (`running-a-dev-cycle` QUICK path).

## Topology choices

| Topology | Shape | When |
| --- | --- | --- |
| **single-loop** | One context; iterate until verified | Default. Anything that fails the escalation tests, or is small enough that fan-out costs more than it saves. |
| **pipeline** | Sequential stages; verify gate between each | Units share files or have data dependencies, but stages still benefit from a hard gate + fresh context per stage. |
| **graph** | Parallel units → gates → integrate | **Both** escalation tests pass (below). |

Flow when not single-loop:

```text
spec → decompose → [parallel implement-node | sequential stages] → verify gates → integrate → review
```

## Escalation tests (both required for graph)

1. **Disjoint file sets, no data dependency.** List each candidate unit's file allowlist.
   Intersection of any two allowlists → **not graph** (use pipeline or single-loop).
   One unit consuming another's uncommitted output (types, modules, migrations not yet in
   the shared contract) → **not graph**.
2. **Independent verifiers.** Each unit has a command that can pass or fail *without*
   the other units existing yet (its own tests, typecheck scope, or build target).
   "We'll know when the full suite is green" is **not** an independent verifier.

If either test fails, choose **pipeline** (ordered stages) or **single-loop**. Never call
overlapping file sets a graph.

## Verifier-first bias (hard stop)

Refuse to declare pipeline or graph if any unit lacks a concrete, runnable verifier
command that already exists or is specified as a *first* task in that unit (write the
test/target before production code). A graph of unverified agents is worse than one loop —
fall back to **single-loop** and say why.

## Execution shape (after topology is chosen)

| Topology | How units run | Concurrency |
| --- | --- | --- |
| **single-loop** | One agentic loop; no unit fan-out | 1 |
| **pipeline** | `implement-node` **one at a time** in merge order; unit verifier between stages; `integrate` full-suite after each accepted stage | 1 |
| **graph** | `implement-node` in parallel waves, then `integrate` in merge order | **≤3** concurrent (same cap as `orchestrating-parallel-agents`); wave the rest |

Match concurrency to review bandwidth. Ten parallel unit diffs you cannot review is
worse than two you can.

## Workflow

1. **Restate the outcome** — one verifiable done-condition for the whole task.
2. **Sketch candidate units** — rough goals + likely file sets (does not need full
   decompose detail yet).
3. **Run the escalation tests** — compute allowlist intersections; name each unit's
   verifier. Record PASS/FAIL evidence in the task file.
4. **Choose topology** — single-loop | pipeline | graph. Prefer the simpler one when
   uncertain.
5. **Always write the task file** — see [references/task-file.md](references/task-file.md).
   Path: `.loadout/tasks/<slug>/TASK.md`. Even **single-loop** gets a minimal TASK.md
   (choice + rationale + full-suite verifier; units section may be empty). This is the
   durable contract artifact — not chat memory.
6. **Hand off**
   - single-loop → `agentic-loop` / `running-a-dev-cycle` (no decompose required).
   - pipeline or graph → `decompose` (fills units, writes the shared contract), then
     dispatch per [references/dispatch-prompt.md](references/dispatch-prompt.md), then
     `integrate`.

## Conflicts & boundaries (do not silently override)

| Existing asset | Relationship |
| --- | --- |
| `orchestrating-parallel-agents` / `clear-the-queue` | Fans out **independent tickets/items**. This skill fans out **units of one task**. Do not use both for the same work without an explicit boundary (queue of tasks vs graph inside one task). |
| `shared-working-tree` / `no-stash` / `git-safety` | If installed: graph units stay on the **single trunk checkout**; no per-unit worktrees/branches unless the user explicitly asks. Parallelism is safe only because allowlists are disjoint. Integrate via sequential apply, not worktree merge. |
| Worktree isolation (when shared-tree kit is **not** installed) | Per-unit worktrees allowed; `integrate` may merge worktrees in declared order. |
| `agentic-loop` | The executor *inside* a single-loop topology and inside each `implement-node` unit. Topology chooses the shape; the loop still verifies. |

## Never do

- Declare graph without both escalation tests passing with evidence in the task file.
- Proceed past a stage whose verifier does not exist.
- Overlap file allowlists and still call it graph.
- Spawn implementers before the task file exists (pipeline/graph).
- Skip writing TASK.md because "it's obviously a single loop."
- Duplicate the body of `orchestrating-parallel-agents` — link it for multi-ticket fan-out.

## Pairs with

- skills: `decompose`, `integrate`, `agentic-loop`, `running-a-dev-cycle`,
  `orchestrating-parallel-agents`, `create-plan`, `review-plan`, `review-build`
- rules: `implement-node-rule`, `shared-working-tree`, `no-stash`, `git-safety`,
  `definition-of-done`, `no-shortcuts`
- agents: `implement-node`, `reviewer`
- workflows: `build-as-graph`, `plan-then-build`, `run-autonomous-loop`, `clear-the-queue`
- commands: `build-as-graph-cmd` (`/build-as-graph`)
- refs: `references/task-file.md`, `references/dispatch-prompt.md`,
  `references/worked-example.md`
- docs: `agentic-patterns`
