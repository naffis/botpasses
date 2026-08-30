---
name: planning-a-change
description: Explore, then plan, then implement a non-trivial change. Use before multi-file work, unfamiliar code, or anything with real trade-offs; skip for one-sentence diffs. For a thorough plan-only artifact ("Create a plan for X"), use create-plan instead.
---

# Planning a change

## Trigger

A change that touches multiple files, modifies unfamiliar code, or has more than one reasonable approach. If you could describe the diff in one sentence, skip this and just do it. If the user only wants a plan (no implementation yet), use `create-plan`.

## Workflow

1. **Classify the task.** Quick fix → implement directly. Enhancement/integration/ambiguous → plan first. Plan-only request → hand off to `create-plan` (`/plan`).
2. **Explore (read-only).** Read the relevant code and tests. Find the existing pattern to follow and the seams you'll touch. Note files with line numbers. Don't edit yet.
3. **Research externally when the domain has public practice.** For non-trivial design forks, run the external-research bar from `create-plan` (best practices / common practice / SOTA with citations) before locking the approach.
4. **Write the plan.** Prefer the `create-plan` artifact standard when trade-offs are real. At minimum: goal, files that change, approach, rejected alternatives, risks, and an end-to-end verification step. No TBD / stubs / "figure out later".
5. **Stress-test the plan.** Prefer `review-plan` (`/review-plan`) when the plan is non-trivial. Where will this break? What did exploration or external research miss? Adjust before writing code.
6. **Implement** against the plan, smallest safe change first, following existing patterns — only when the user asked to build, not plan-only.
7. **Verify** with the check named in the plan; show the evidence. For non-trivial work, close with `review-build` (`/review-build`) before shipping.

## Guardrails

- Separate research from implementation; don't let exploration silently turn into edits.
- If you correct course more than twice, stop and re-plan rather than pushing on.
- Do not weaken `create-plan` / `no-shortcuts` / `definition-of-done` to ship faster.

## Pairs with

- rules: `create-plan-rule`, `no-shortcuts`, `size-limits`, `testing-conventions`, `definition-of-done`
- skills: `create-plan`, `review-plan`, `review-build`, `reviewing-and-shipping`, `debugging-an-issue`
- commands: `plan` (`/plan`), `review-plan-cmd` (`/review-plan`), `review-build-cmd` (`/review-build`)
- workflows: `ship-a-feature`, `plan-then-build`, `onboard-to-codebase`, `run-autonomous-loop`,
  `clear-the-queue`
