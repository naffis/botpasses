# Task file template

Write to `.loadout/tasks/<slug>/TASK.md` for **every** topology choice (including
single-loop). This file is the contract for `decompose`, `implement-node`, and
`integrate`. Only `task-topology` / `decompose` may redefine units and allowlists;
implementers read, they do not edit topology.

Status vocabulary (everywhere): `pending` | `running` | `PASSED` | `FAILED` |
`integrated`. Implement-node reports `PASSED` / `FAILED` only.

```markdown
# Task: <slug>

## Outcome

<verifiable done-condition for the whole task>

## Spec pointer

- Plan / ticket / request: <path or quote>

## Topology

- Choice: single-loop | pipeline | graph
- Escalation test 1 (disjoint files / no data dep): PASS | FAIL — <evidence>
- Escalation test 2 (independent verifiers): PASS | FAIL — <evidence>
- Rationale: <why this topology; why not the simpler one>

## Shared contract

- Path: `.loadout/tasks/<slug>/contract.<ext>`   <!-- N/A for single-loop -->
- Editor: `decompose` only (implement-node units import/consume; never edit)

## Full-suite verifier

<!-- Project gate; used by integrate after each merge and at the end -->
`<command>`

## Units

<!-- single-loop: omit or leave empty -->

### U-01: <name>

- Goal:
- File allowlist: (`path/a`, `path/b`, …)  <!-- explicit; empty allowlist = fail -->
- Exposes / consumes: <symbols from contract>
- Verifier: `<command>`  <!-- must be runnable for this unit alone -->
- Done-condition: <binary>
- Status: pending | running | PASSED | FAILED | integrated

### U-02: …

## Merge order

1. U-0N
2. U-0M
…

## Isolation mode

- shared-trunk | worktrees
- Reason: <shared-working-tree installed? user asked for worktrees?>

## Notes / failures

- …
```

## Rules for the file

- Every unit lists an **explicit file allowlist** (no globs that swallow the repo; tight
  globs like `src/foo/**` are OK when the unit owns that tree).
- Allowlist intersection across units that run in parallel must be empty for **graph**.
- Pipeline units may overlap files only if merge order makes them strictly sequential.
- Verifier commands are copy-pasteable shell; "manual check" is not a verifier unless the
  task is single-loop and the project has no automated gate for that surface (call that out).
- Status fields are updated by the orchestrator (`integrate` / parent), not by rewriting
  goals after the fact to match a bad implementation.
- Prefer committing TASK.md with the change when it documents topology for reviewers;
  otherwise keep it as local workflow state under `.loadout/` (same family as
  `.loadout/state/`).
