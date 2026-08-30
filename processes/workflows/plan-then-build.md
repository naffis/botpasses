---
name: plan-then-build
uses:
  rules:
    [
      no-shortcuts,
      size-limits,
      testing-conventions,
      test-coverage,
      regression-test,
      documentation-updates,
      definition-of-done,
      commit-and-pr-conventions,
      create-plan-rule,
      review-plan-rule,
      review-build-rule,
      complete-the-build-rule,
    ]
  skills:
    [
      create-plan,
      review-plan,
      complete-the-build,
      review-build,
      deep-flight,
      post-flight,
      verifying-session-surfaces,
      agentic-loop,
      writing-tests,
      updating-docs,
      reviewing-and-shipping,
      writing-commit-messages,
      opening-a-pr,
      making-a-pr-reviewable,
      simplifying-code,
      test-driven,
    ]
  agents: [reviewer, flight-checker]
  commands:
    [
      plan,
      review-plan-cmd,
      complete-the-build-cmd,
      deep-flight-cmd,
      review-build-cmd,
      post-flight-cmd,
      verifying-session-surfaces-cmd,
    ]
gate: "<project typecheck + test + lint command>"
stop_condition: "reviewed plan approved, implementation matches the plan, review-build PASS, gate green, docs updated, reviewer verdict SAFE, PR opened (if asked)"
state: ".loadout/state/plan-then-build.md"
---

# Plan then build

The high-rigor path for non-trivial, unfamiliar, or high-stakes work: a complete
zero-shortcut plan, an adversarial plan review, implementation, then an
evidence-first build review. Prefer this over `ship-a-feature` when a shallow
sketch would leave decisions to coding time. Prefer `ship-a-feature` for ordinary,
well-understood changes where `planning-a-change`'s short plan is enough. Prefer
`run-autonomous-loop` only after `loop-preflight` passes and you want unattended
execution against a contract.

Slash shortcuts: `/plan` → create the plan; `/review-plan` → stress-test it;
`/complete-the-build` → exhaust open Partial/Missing/Punted rows;
`/deep-flight` → mid-build course-correct; `/verify-surfaces` → live-surface
exercise + root-cause-fix; `/review-build` → verify the
implementation; `/post-flight` → same-session fix-mode wrap (sibling sweep +
deferred work) when the user asks. Prefer
`/review-plan` and `/review-build` in a **fresh chat** when the stakes are high
(maker ≠ checker).

**Equip note:** `uses.rules` lists registry rule ids (`create-plan-rule`,
`review-plan-rule`, `complete-the-build-rule`, `review-build-rule`) — those are
what `loadout add` installs. The skill ids (`create-plan`, `review-plan`,
`complete-the-build`, `review-build`) are separate and also required.

1. **Frame** — write the outcome, constraints, non-goals, and verifiable done-condition into
   the state file. If the repo is unfamiliar, run `onboard-to-codebase` first. Do not write
   implementation code in this step.
2. **Create the plan** — `create-plan` (`/plan`) in full: in-repo evidence first, mandatory
   external research (SOTA / common practice / pitfalls / primary sources), EARS-style
   acceptance criteria, mini-ADRs for real trade-offs, executable tasks, and for nontrivial
   work a **topology declaration** (`task-topology` / plan §8b). Ban TBD, stubs,
   placeholders, and "figure out during implementation" for anything in scope
   (`create-plan-rule` + `no-shortcuts`). If topology is pipeline/graph, prefer the
   `build-as-graph` workflow for implementation rather than an unstructured fan-out.
3. **Stress-test the plan** — `review-plan` (`/review-plan`) in full: re-read plan + live
   code, fresh external research, PASS/FAIL checklist with evidence (including topology
   escalation tests), pre-mortem, adversarial critique, fix shortcuts **in the plan file**,
   final sweep. Chat-only critique without editing the plan is a failure (`review-plan-rule`).
   Do not implement until the plan verdict is APPROVED or APPROVED WITH CONDITIONS
   (conditions listed and accepted).
4. **Implement against the plan** — smallest safe change first; follow existing patterns;
   update the plan if reality diverges (the plan stays the source of truth). No side quests.
   Pipeline/graph → `decompose` → `implement-node` → `integrate` (`build-as-graph`).
5. **Exhaust open rows** — if any plan phase/AC is still Partial / Missing / Punted,
   run `complete-the-build` (`/complete-the-build`): gap matrix before coding, build to
   empty, two clean passes (`complete-the-build-rule`). Do not jump to review-build with
   open rows.
6. **Test** — `writing-tests` (or `test-driven` / `/tdd` when the user wants the hard
   loop): new behavior, edges, error paths (`test-coverage`); any bug found mid-build
   gets a fail-before/pass-after test (`regression-test`).
7. **Verify** — run the `gate`; show the evidence. Optional clarity pass:
   `simplifying-code` (`/simplify`) on the diff before review.
   7b. **Session surfaces** — `verifying-session-surfaces` (`/verify-surfaces`)
   for every user-visible surface the plan shipped. Live evidence; `root-cause-fix`
   any BROKEN. Skip only for library-only diffs with no reachable consumer.
8. **Docs in the same change** — `updating-docs` for every surface the change altered
   (`documentation-updates`, `definition-of-done`).
   8b. **In-flight check** — after substantial implement, `deep-flight` (`/deep-flight`)
   before claiming done: chosen layer, RECEIPT, quoted gates, `flight-checker`.
9. **Review the build** — `review-build` (`/review-build`): ground-truth diff, plan/requirement
   trace, shortcut sweep, gate with pasted output, fix blockers/majors. Prefer a fresh chat.
   Do not proceed on FAIL (`review-build-rule`).
10. **Maker ≠ checker** — dispatch the `reviewer` agent on the diff **vs the approved plan**.
    Fix correctness/intent gaps; ignore over-engineering suggestions that reopen decided ADRs
    without new evidence.
11. **Commit & PR** — `writing-commit-messages`, then `opening-a-pr` with a validation-first
    description. For a noisy/large diff, `making-a-pr-reviewable` first. Only if the user
    asked (`commit-and-pr-conventions`).

Run steps 4–10 as verified loops (`agentic-loop`): stop contract, ground-truth verify, edits
left unstaged. Never start step 4 with an incomplete plan, never skip `review-plan` on work
that justified `create-plan`, and never skip `review-build` before calling the change done.
