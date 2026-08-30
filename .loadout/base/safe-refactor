---
name: safe-refactor
uses:
  rules: [refactor-discipline, size-limits, testing-conventions, no-shortcuts, definition-of-done, documentation-updates]
  skills: [reviewing-code-quality, refactoring-code, writing-tests, updating-docs, reviewing-and-shipping]
  agents: [reviewer]
gate: "<project typecheck + test + lint command>; characterization tests green before and after every move"
stop_condition: "scoped maintainability findings addressed with behavior-preserving moves only, gate green throughout, reviewer verdict SAFE (no behavior change), docs updated if public seams moved"
state: ".loadout/state/safe-refactor.md"
---

# Safe refactor

Behavior-preserving structural improvement behind a test net — assessment, then small green-
to-green moves, then an independent check that nothing's behavior changed. Use when cleaning
up an oversized module, flattening nesting, or breaking a cycle. Do **not** use this to sneak
in features or bug fixes (those are `ship-a-feature` / `root-cause-fix`). Do not use it when
tests don't exist and can't reasonably be added — say so and stop.

1. **Scope** — name the target (file/module/package) and the non-goals in the state file.
   Explicitly forbid: behavior changes, dependency bumps, drive-by features, "while I'm here"
   bug fixes. Park those as follow-ups.
2. **Assess** — `reviewing-code-quality` on the target: size, nesting, duplication, leaky
   boundaries, naming, dead weight, error-handling smells. Prioritize must-fix (actively
   harmful) vs nice-to-have. Don't rewrite for taste.
3. **Establish the test net** — per `refactor-discipline` / `refactoring-code`: if the
   behavior you're moving isn't covered, add characterization/boundary tests that pin current
   behavior **before** any structural edit (`writing-tests`). If you cannot add a net, stop
   and say so — refactoring without a net is a rewrite in disguise.
4. **Plan the target shape** — seams, extracted modules/functions, stable public APIs. Keep
   the plan short and in the state file; this is not `create-plan` unless the refactor is
   cross-cutting and high-risk (then escalate to `plan-then-build`).
5. **Move in small pure steps** — `refactoring-code`: extract, move, rename, re-export. Run
   the `gate` after **each** step (green → green). Keep public APIs stable where possible;
   if a signature must change, update call sites in the same step. No side quests.
6. **Docs if seams moved** — `updating-docs` for import guides / module docs / ADRs only when
   a public boundary changed (`documentation-updates`, `definition-of-done`). Skip doc churn
   for internal extracted helpers.
7. **Maker ≠ checker** — dispatch the `reviewer` with an explicit charge: **report any
   behavior change or intent drift; ignore pure style.** A SAFE verdict means "same behavior,
   clearer structure."
8. **Ship** — `reviewing-and-shipping` only if the user asked. Prefer the refactor on its own
   commit/PR so review sees only structural change.

Never mix a behavior fix into the refactor branch. Never delete a failing characterization
test to stay green. Never claim "done" while the gate is red or the reviewer reports a
behavior change.
