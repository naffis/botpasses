---
name: review-plan
description: >
  Extensively review and improve an existing implementation plan before coding.
  Use when the user says "Review the plan", "Review this plan", "review plan",
  "stress-test the plan", "go deeper on the plan", "improve the plan", or asks
  to re-check planning work. Re-read session + plan + code, fresh external
  research, pre-mortem, adversarial critique, fix shortcuts in the plan,
  plan-ban-sweep RECEIPT, then isolated plan-checker. Anti-triggers: create a
  new plan → create-plan; implement now; ordinary code review; claimed-done
  vs plan → review-build. Prefer over deep-planning-review.
---

# Review a plan

You are **not** summarizing and you are **not** rubber-stamping. Stress-test,
do fresh research, and **rewrite the plan** until it meets the `create-plan`
bar. Do not implement code.

Routing: `_shared/plan-build-family.md`.

## Immediate action

1. Read `.cursor/rules/review-plan.mdc` (bans).
2. Edit the plan artifact(s) — chat-only critique is a failure. Update the
   workspace research `.md` **and** refresh **CreatePlan** so **Build** matches
   (`create-plan/references/cursor-native-plan.md`).

## Workflow

### Pass 0 — Locate and re-read

Find the plan (user path, `.cursor/plans/`, session CreatePlan). Re-read it
entirely. Re-read live code + owning docs; verify assumptions.

### Pass 1 — Spec-review gate

| Dimension    | Pass criteria                                       |
| ------------ | --------------------------------------------------- |
| Scope        | One problem; non-goals strong enough to block creep |
| Acceptance   | Every AC binary-testable; no subjective language    |
| Contracts    | API/tool/job/UI complete; compat + migration        |
| Dependencies | Named with fallback; no "TBD integration"           |
| Operations   | Rollout, monitoring, **viable rollback**            |
| Surfaces     | tool-exposure, KV, prompts, docs/changelog          |
| Traceability | requirement → design → task → verification          |
| Shortcuts    | No stubs or "decide during implementation"          |

Block coding when rollback/deps/ACs/scope/security are open.

### Pass 2 — Fresh external research

New searches aimed at **holes** (do not only trust the plan's citations).
Adopt / adapt / reject with URLs. SOTA vs invariants → choose explicitly.

### Pass 3 — Pre-mortem + adversarial

3–5 concrete failure narratives (3–6 months later) + mitigations in the plan.
Lenses: correctness, security/tenancy, reliability, operability, simplicity,
implementability. Falsify key decisions. Name one serious alternative not
chosen.

### Pass 4 — Apply fixes

All P0/P1 into the plan file. Add a **Review changelog**. Prefer fixing over
conditioning.

### Pass 5 — Mechanical close (not "think harder")

Adding another "be very thorough" pass is the proximate patch that made this
skill come up short. Prove instead:

```bash
.cursor/skills/_shared/scripts/plan-ban-sweep.sh .cursor/plans/<file>.md
```

Quote the `RECEIPT`. Then launch **`plan-checker`** (`readonly`, no `resume`).
FAIL → fix P0/P1, one recheck. Same-session degrade cannot yield APPROVED.

## Review report

```markdown
# Plan review: <plan name>

## Verdict

APPROVED | APPROVED WITH CONDITIONS | BLOCKED

## Passes

- Pass 0–4: …
- plan-ban-sweep: RECEIPT quoted
- plan-checker: PASS / FAIL

## Blockers found → resolved

## P1 fixes applied

## Fresh sources (URL + takeaway)

## Pre-mortem → mitigations

## Review changelog

## Conditions — or "none"
```

## Never do

- Rubber-stamp or single-pass skim
- Leave TBD/stubs; skip fresh research
- Chat-only critique; stale CreatePlan / Build UI
- Self-grade APPROVED without `plan-checker` PASS
- Implement unless the user clicks Build or asks after approval

## Pairs with

- skills: `create-plan`, `complete-the-build`, `review-build`,
  `planning-a-change`, `writing-an-adr`, `researching-a-dependency`,
  `task-topology`, `decompose`
- agents: `plan-checker`
- rules: `review-plan-rule`, `create-plan-rule`, `no-shortcuts`,
  `definition-of-done`, `implement-node-rule`
- refs: `_shared/plan-build-family.md`, `_shared/scripts/plan-ban-sweep.sh`
- commands: `plan` (`/plan`), `review-plan-cmd` (`/review-plan`),
  `review-build-cmd`
- workflows: `plan-then-build`, `build-as-graph`
- docs: `docs/plan-build-family.md`
