---
name: decompose
description: >
  Turn a spec and task-topology declaration into sized work units with file allowlists,
  shared interface contracts, per-unit verifiers, and done-conditions. Use after
  task-topology chooses pipeline or graph, or when asked to "decompose this task", "split
  into work units", or "write the unit contracts". Anti-triggers: topology still unknown →
  task-topology first; implementing a unit → implement-node; merging units → integrate;
  single-loop tasks → agentic-loop (no decompose).
---

# Decompose

Turn the topology sketch into executable units. Interfaces between units are defined
**here, before implementation** — written to a shared contract file that every unit
imports and **only this stage may edit**.

Requires a task file from `task-topology` (pipeline or graph). Does not restate that
skill's escalation tests; if they no longer hold after sizing, rewrite topology first.

## Trigger

- `task-topology` chose pipeline or graph and handed off here.
- User asks to split a nontrivial task into implementable units with boundaries.

## Sizing rule (hard)

A unit is **one agent-session of work**. If a unit needs its own decomposition, the
decomposition failed — redo it (merge units, shrink goals, or push shared types into the
contract and re-slice). Nested graphs are a smell; flatten or choose single-loop.

## Verifier-first (hard stop)

Do not finalize a unit that has no independently runnable verifier command. Prefer writing
the verifier (test file / target name) into the unit's allowlist as work the unit owns.
If you cannot name a verifier, the unit is not ready — return to `task-topology` and
likely choose single-loop.

## Workflow

1. **Read** `.loadout/tasks/<slug>/TASK.md` and the spec/plan it points at.
2. **Confirm topology still holds** after you list real file allowlists. Intersection on
   a graph → fail back to `task-topology` (pipeline or single-loop).
3. **Write the shared contract** to `.loadout/tasks/<slug>/contract.<ext>`:
   - Types, function signatures, event/schema shapes, error codes — whatever units share.
   - Stable names. No implementation bodies except empty stubs required for typecheck
     *if* the language demands them; prefer pure types.
   - This file is on **no unit's allowlist for edit**. Units may import it; only
     `decompose` (or an explicit re-decompose pass) edits it.
4. **Fill each unit** in the task file:

   | Field | Required content |
   | --- | --- |
   | Goal | One sentence outcome |
   | File allowlist | Explicit paths the unit may create/edit |
   | Exposes / consumes | Contract symbols |
   | Verifier | Shell command, unit-scoped |
   | Done-condition | Binary, tied to verifier + goal |

5. **Set merge order** — dependencies first; for graph, order is integrate order only
   (units still run in parallel, waves ≤3). For pipeline, order is both execution and
   merge order (strictly serial implement-node).
6. **Self-check**
   - [ ] Every unit ≤ one session; none need nested decompose
   - [ ] Graph: allowlists pairwise disjoint; no hidden data deps outside the contract
   - [ ] Every verifier exists or is the first deliverable in that unit
   - [ ] Contract covers every cross-unit interface; no "we'll figure out the type later"
   - [ ] Full-suite verifier named for `integrate`
   - [ ] Isolation mode recorded (honor `shared-working-tree` if installed)
7. **Hand off** — dispatch `implement-node` using the prompt in
   `task-topology/references/dispatch-prompt.md`. Pipeline: one at a time. Graph: up to
   3 concurrent. Do not implement production code in this stage.

## Contract file conventions

- Prefer the project's language (`contract.ts`, `contract.py`, etc.) so units typecheck
  against the real interface.
- Document each export with one line: who produces, who consumes.
- Changing the contract mid-flight is a **re-decompose**: stop implementers, edit
  contract, update unit entries, re-dispatch affected units. Never let one unit "just
  patch" the contract.

## Never do

- Leave cross-unit types as tribal knowledge in chat.
- Size a unit larger than one session "to save orchestration overhead."
- Put the contract path on a unit allowlist as writable.
- Proceed when a unit has no verifier.
- Implement production code in this stage.

## Pairs with

- skills: `task-topology`, `integrate`, `create-plan`, `agentic-loop`, `writing-tests`
- rules: `implement-node-rule`, `definition-of-done`, `no-shortcuts`, `shared-working-tree`
- agents: `implement-node`
- workflows: `build-as-graph`
- refs: `../task-topology/references/task-file.md`,
  `../task-topology/references/dispatch-prompt.md`
