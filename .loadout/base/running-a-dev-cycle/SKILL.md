---
name: running-a-dev-cycle
description: >
  Adaptive end-to-end development cycle: classify a task and route it through the LIGHTEST
  appropriate path (QUICK for small fixes, ENHANCEMENT for bounded features, INTEGRATION for new
  tech, INVESTIGATION for open questions, ITERATION for improve-on-feedback), composing loadout's
  skills and workflows, and running each phase as a verified agentic loop. Use for "build this
  end to end", "run the full workflow", "take this from idea to shipped", "autonomous mode", or
  starting a substantial feature. Anti-triggers: just recommend where to start / emit a kickoff
  prompt -> getting-started; run one task as a loop -> agentic-loop; ship one bounded feature ->
  the ship-a-feature workflow; run many items in parallel -> orchestrating-parallel-agents;
  split one task into verified units -> task-topology / build-as-graph.
---

# Running a dev cycle

An adaptive development cycle that routes a task through the right phases based on its type. It
**classifies** the work, then runs only the phases that type needs — each phase as a verified
`agentic-loop` — composing loadout's existing skills and workflows rather than re-implementing
them. This is the executor; `getting-started` is the advisor that recommends and hands off here.

## When to use

- A substantial task where you'll actually do the work end to end, not just plan it.
- "Build X end to end", "run the full cycle", "autonomous mode".

Use something lighter when it fits: `getting-started` (just route + kickoff prompt),
`agentic-loop` (one task as a loop), the `ship-a-feature` workflow (one bounded feature).

## Phase 0 — intake & classify

Capture the essentials, then pick the **lightest** classification that fits (don't over-process
simple work):

1. **Objective / done-condition** — what does "done" look like, verifiably?
2. **Constraints & out-of-scope** — stack, compatibility, what this must NOT do.
3. **Provided resources** — URLs, repos, papers, tickets. If URLs were given, they feed the
   research phase.
4. **Unknowns** — technologies/APIs/patterns you'd have to learn before building.

| Type | Signals | Route |
| --- | --- | --- |
| **QUICK** | 1-3 files, no new patterns, "fix/change/rename/tweak" | READ -> IMPLEMENT -> gate -> done (no plan file) |
| **ENHANCEMENT** | known area, 3-10 files, "add feature/improve X" | PLAN(light) -> BUILD+TEST -> [VERIFY?] -> [DOCS?] |
| **INTEGRATION** | new tech/API/library/service | RESEARCH -> PLAN(full) -> REVIEW -> BUILD+TEST -> VERIFY -> DOCS |
| **INVESTIGATION** | "evaluate/compare/is it possible/explore" | RESEARCH -> FINDINGS -> decision (build or stop) |
| **ITERATION** | "improve quality/make it better", prior work exists | [RESEARCH?] -> PLAN(light) -> BUILD+TEST -> EVALUATE -> loop or ship |

State the classification explicitly before proceeding. If a QUICK task turns out larger than
expected (>5 files, new patterns, architectural decisions), **reclassify** as ENHANCEMENT.

## The phases (each maps to a loadout asset)

Run each phase as an `agentic-loop`: write the stop contract, verify against ground truth, keep
edits unstaged, use a maker-checker before a gate is called met. Every phase has a **gate**;
don't proceed until it's satisfied.

| Phase | Loadout asset | Gate |
| --- | --- | --- |
| RESEARCH | `researching-a-dependency` | Every unknown resolved; each new dependency has a reference doc with auth/API/errors/gotchas |
| PLAN | `planning-a-change` (+ `reviewer` for a full-mode stress test) | A plan with phased tasks, acceptance criteria, and risks |
| BUILD + TEST | `agentic-loop` execution + `writing-tests` under `no-shortcuts`/`size-limits` | Phase code complete; tests (happy + failure + edge) pass |
| VERIFY | `reviewing-and-shipping` (+ `assessing-release-readiness` if promoting) | Independent review verdict SAFE; the gate green |
| DEPLOY (if a live service) | `multi-plane-deploy` runbook | Deploy verified healthy; post-deploy checks pass |
| DOCS | `updating-docs` | Doc surfaces the change touched are updated in the same change |
| FIX (defects found) | `root-cause-fix` | Each defect has a proven root cause + a class fix + regression test |

Skip a phase only when the routing table for the task type omits it (e.g. ENHANCEMENT skips
RESEARCH when there are no unknowns, and skips VERIFY/DOCS when it adds no new public surface).
You cannot skip a mandatory phase for the type.

## QUICK path (lightweight)

For QUICK tasks only. No plan file, no phase ceremony:

1. **Read** the files that change; understand current behavior.
2. **Implement** the minimal focused change.
3. **Verify** — lints on changed files, the affected tests, the build/typecheck.
4. **Done** — leave edits unstaged; summarize. (Do not create plan/report artifacts.)

## Progress tracking

On a multi-phase run, keep a compact status visible (a `TodoWrite` ledger, or a `STATE.md` for
long/cross-session work) so a fresh context can resume:

```
Task type: <QUICK/ENHANCEMENT/INTEGRATION/INVESTIGATION/ITERATION>
Phase: <current phase>
Progress: <what's done in this phase>
Gate: <what's needed to proceed>
```

## Autonomy & circuit breaker

- **Autonomous by default:** run phases without pausing at every gate; show the status ledger.
  Stop only on the circuit breaker.
- **Circuit breaker — stop and ask when:** the same error persists after 2 fixes; fixing one
  thing keeps breaking another; the correct approach needs an architecture change not in the
  plan; a security concern you can't resolve safely; about to touch irreversible data;
  requirements are genuinely ambiguous. Don't spiral — stop, explain, ask.
- **Git-safe:** never commit/branch/push/PR unless the user explicitly asks
  (`commit-and-pr-conventions`); autonomy is edit-and-verify only.
- **Minimum-iteration honesty (ITERATION):** if the task set a minimum number of iterations, a
  single clean result early does not let you stop before the minimum.

## Ground rules

- Classify at intake; the classification determines the route.
- Each phase has a gate; don't proceed until it's met.
- The plan is the source of truth; if reality diverges, update the plan.
- When a phase maps to a loadout skill/workflow, follow it in full — this skill says WHEN, the
  phase asset says HOW.
- Quality over speed. Correct + documented beats fast + broken.

## Pairs with

- skills: `getting-started`, `agentic-loop`, `planning-a-change`, `researching-a-dependency`,
  `reviewing-and-shipping`, `root-cause-fix`, `writing-tests`, `updating-docs`, `task-topology`
- agents: `reviewer`
- workflows: `ship-a-feature`, `run-autonomous-loop`, `clear-the-queue`, `plan-then-build`,
  `build-as-graph`
- docs: `agentic-patterns`
