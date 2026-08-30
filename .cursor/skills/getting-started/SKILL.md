---
name: getting-started
description: Recommend how to proceed on a goal and produce a ready-to-run kickoff prompt. Use when you're new to a project or unsure where to begin — "I want to build X, what should I do?", "how do I start?", "which workflow applies?". Routes the goal to the right loadout workflow, skills, and rules, and decides manual vs autonomous loop. Also routes "use/install/update loadout" to equipping-loadout / INSTALL.md.
---

# Getting started

## Trigger

You have a goal but not a plan: "I want to build X", "what should I do?", "how do I start?", or you just loaded loadout into an unfamiliar repo and don't know which workflow to run.

## Workflow

1. **Get the goal clear.** If the request is vague or large, interview briefly (one short round): what's the outcome, the constraints, the **done-condition**, and what's explicitly out of scope. Don't over-ask — one or two sharp questions, then proceed. (Anthropic's "let the agent interview you" pattern.)
2. **Orient if new to the repo.** If you don't know the codebase yet, run the `onboard-to-codebase` workflow (it uses the `explorer` agent) to learn the stack, the change pattern, and the test/build commands before committing to an approach.
3. **Classify the work and route to a workflow:**
   - Seed thought / "deep dive:" / "dig in:" / "what's the best way to X" (not yet a plan or a fix) → **`deep-dive`**.
   - Build/change a feature (ordinary, well-understood) → **`ship-a-feature`**.
   - High-stakes / unfamiliar / multi-file with real trade-offs → **`plan-then-build`**
     (`/plan` → `/review-plan` → implement → `/complete-the-build` when open →
     `/review-build`).
   - Red CI / failing build → **`fix-ci-until-green`**.
   - Staging/prod failure, no local repro yet → **`debug-production`** (evidence first).
   - Immediate outage action (rollback / flag / surgical hotfix) → **`hotfix-and-rollback`**
     runbook, then finish the class fix via `debug-production` / `root-cause-fix`.
   - Security review of a diff/surface → **`security-pass`**.
   - Several independent tickets at once → **`clear-the-queue`**.
   - One nontrivial task that may split into file-bounded verified units (or you need to
     decide single-loop vs pipeline vs graph) → **`build-as-graph`** / `task-topology`
     (default stays single-loop; not a ticket queue).
   - Behavior-preserving cleanup → **`safe-refactor`**.
   - Schema/data migration → **`ship-a-migration`**.
   - Dependency upgrade / bump PR → **`dependency-bump`**.
   - Promote / release → **`cut-a-release`**.
   - Learn a codebase → **`onboard-to-codebase`**.
   - User pasted loadout / "use this" / "update loadout" → **`equipping-loadout`**
     (follow repo-root `INSTALL.md` / `doc-install`); do not improvise install steps.
   - Brand-new / unequipped repo (no loadout yet) → **`equipping-loadout`** / `INSTALL.md`
     for the fast path, or **`bootstrap-project`** for the progressive human path.
   - Attended end-to-end across phases (research→plan→build→verify→docs) →
     **`running-a-dev-cycle`** (classifies the task; each phase is an `agentic-loop`).
   - Unattended until-contract-met (passed `loop-preflight`) → **`run-autonomous-loop`**.
   - Already implemented; need evidence-first verification → **`review-build`**
     (`/review-build`), preferably in a fresh chat — or the full **`plan-then-build`**
     path if plan review is still owed too.
   - Mid-session after substantial edits; course-correct before claiming done →
     **`deep-flight`** (`/deep-flight`). Not `deep-dive`.
   - End of a session; prove live surfaces work, then root-cause-fix →
     **`verifying-session-surfaces`** (`/verify-surfaces`). Prefer when the
     ask is "test all the surfaces / ensure it works."
   - End of a session; fix what the proof turns up (sibling sweep + checker) →
     **`post-flight`** (`/post-flight`). Prefer over a chat-only wrap-up summary.
     Run `/verify-surfaces` first when the session added user-visible surfaces.
   - Open plan phases still Partial/Missing/Punted → **`complete-the-build`**
     (`/complete-the-build`) before review-build.
   - Context dying / switching chats mid-task → **`session-handoff`**
     (`/session-handoff`).
   - Approved a shallow fix / "do it correctly" → **`do-it-right`** (`/do-it-right`).
   - Want strict test-first → **`test-driven`** (`/tdd`).
   - Large agent diff feels overbuilt → **`simplifying-code`** (`/simplify`) then
     review-build.
   - Improve product quality by using it ("dogfood it", "review the UI", "find and fix
     issues end to end") → **`run-quality-loop`** (`exercising-the-product` for behavior,
     `reviewing-ui` for UX; `recreating-a-design` when matching a specific visual target).
   - No single workflow fits → compose from skills (`planning-a-change` or `create-plan`
     first), and say so.
4. **Decide manual vs autonomous loop.** Run the `loop-preflight` 4-condition test (repeats? automated verification? budget? agent has tools?). If it passes **and** the user wants unattended execution, recommend **`run-autonomous-loop`** (or schedule via the `automation-loop` template + a `STATE.md`). Otherwise recommend a single attended run (`ship-a-feature` / `plan-then-build` / `running-a-dev-cycle`). Respect the execution-order law: get a manual run reliable before scheduling anything.
5. **Emit a kickoff prompt.** Output a concrete, paste-ready prompt that names the workflow, the objective, the **gate** (the project's test/lint command), the **done-condition**, and the key constraints/rules. This is the thing the user runs to actually start.

## Output

A short recommendation (which workflow + supporting skills/rules, and manual vs loop), then the kickoff prompt in a fenced block. Keep it to the point. Example shape:

```
Plan: ship-a-feature (manual; doesn't pass the loop test yet).
Kickoff prompt:
  Use the ship-a-feature workflow to add <X>. Explore first and write a short plan
  (planning-a-change). Implement the smallest safe change, add tests for the new
  behavior and error paths, update docs in the same change. Gate: `npm test && npm run lint`.
  Done when: <verifiable condition>. Then dispatch the reviewer subagent and open a PR.
```

## Guardrails

- Be a thin orchestrator: sequence and hand off to the workflow/skills; don't redo their work here.
- Write the done-condition before recommending a kickoff — a goal without a verifiable end is not ready to run, especially as a loop.
- Don't recommend a loop for one-off, unverifiable, or high-stakes work (see `loop-preflight`).

## Pairs with

- workflows: `ship-a-feature`, `plan-then-build`, `onboard-to-codebase`, `fix-ci-until-green`,
  `debug-production`, `security-pass`, `clear-the-queue`, `build-as-graph`, `safe-refactor`,
  `ship-a-migration`, `dependency-bump`, `cut-a-release`, `run-quality-loop`, `run-autonomous-loop`
- skills: `planning-a-change`, `create-plan`, `review-plan`, `complete-the-build`,
  `review-build`, `deep-flight`, `post-flight`, `verifying-session-surfaces`, `session-handoff`, `do-it-right`, `deep-dive`, `test-driven`, `simplifying-code`,
  `running-a-dev-cycle`, `agentic-loop`, `task-topology`, `equipping-loadout`
- commands: `start` (`/start`), `plan` (`/plan`), `build-as-graph-cmd` (`/build-as-graph`),
  `review-plan-cmd` (`/review-plan`),
  `complete-the-build-cmd` (`/complete-the-build`), `deep-flight-cmd` (`/deep-flight`), `review-build-cmd` (`/review-build`), `post-flight-cmd` (`/post-flight`),
  `verifying-session-surfaces-cmd` (`/verify-surfaces`),
  `session-handoff-cmd` (`/session-handoff`), `do-it-right-cmd` (`/do-it-right`),
  `tdd-cmd` (`/tdd`), `simplify-cmd` (`/simplify`)
- runbooks: `loop-preflight`, `harness-setup`, `bootstrap-project`, `hotfix-and-rollback`
- templates: `automation-loop`, `state-file`
- docs: `catalog` (the menu of everything available), `doc-install` (`INSTALL.md`)
