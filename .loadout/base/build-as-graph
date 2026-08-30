---
name: build-as-graph
uses:
  rules:
    [
      implement-node-rule,
      no-shortcuts,
      definition-of-done,
      regression-test,
      testing-conventions,
      commit-and-pr-conventions,
      shared-working-tree,
      no-stash,
      git-safety,
    ]
  skills:
    [
      task-topology,
      decompose,
      integrate,
      create-plan,
      review-plan,
      review-build,
      agentic-loop,
      writing-tests,
      committing-on-shared-trunk,
    ]
  agents: [implement-node, reviewer, security-reviewer]
gate: "task file topology declared; every unit verifier green before integrate; full-suite verifier green after each merge and at end; allowlists respected; review-build PASS (incl. unit-boundary check)"
stop_condition: "outcome in TASK.md met; integrate complete; no unit left FAILED without explicit user decision; edits unstaged unless user asked to land"
state: ".loadout/tasks/<slug>/TASK.md"
---

# Build as a graph

Structure **one** nontrivial task as a verified agent graph (or refuse and stay a
single loop). Named recipe around `task-topology` → `decompose` → `implement-node` →
`integrate`. Not for a queue of independent tickets (`clear-the-queue` /
`orchestrating-parallel-agents`).

**Shared-tree fork:** if `shared-working-tree` / `no-stash` / `git-safety` are installed,
graph units stay on one trunk checkout; disjoint allowlists are what make parallelism
safe. No per-unit worktrees unless the user explicitly asks.

1. **Topology** — run `task-topology`. **Always** write `.loadout/tasks/<slug>/TASK.md`.
   Default **single-loop** → hand off to `agentic-loop` / `running-a-dev-cycle` and stop
   using the rest of this workflow. Escalate to **pipeline** or **graph** only when the
   skill's tests pass. Refuse pipeline/graph if any unit lacks a verifier.
2. **Plan (optional but preferred)** — for high-stakes work, `/plan` including §8b
   topology; `/review-plan` before build.
3. **Decompose** — `decompose` fills units, writes `.loadout/tasks/<slug>/contract.*`,
   sets merge order. Sizing: one agent-session per unit; nested decompose = failure.
4. **Implement** — dispatch `implement-node` with the prompt in
   `task-topology/references/dispatch-prompt.md`. Pipeline: **serial**. Graph: parallel
   waves of **≤3**. Each worker: allowlist + contract read-only + own verifier;
   PASSED or FAILED only.
5. **Integrate** — `integrate` in merge order; **full-suite** verifier after each accept;
   re-dispatch contract violators; no hand-fixes across boundaries; end with spec review
   for divergent interface interpretations.
6. **Review** — `/review-build` (prefer fresh chat): plan trace **and** git-diff vs unit
   allowlists. Dispatch `reviewer` (and `security-reviewer` when auth/input/secrets).
7. **Land** — only if the user asked; whole-tree commit via `committing-on-shared-trunk`
   when shared-tree kit applies.

Never call overlapping file sets a graph. Never proceed past a missing verifier. Never
let integrate paper over a bad contract. Cap graph concurrency at 3.
