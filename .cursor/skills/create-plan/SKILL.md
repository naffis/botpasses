---
name: create-plan
description: >
  Create a complete, zero-shortcut implementation plan before coding. Use when
  the user says "create-plan", "run create-plan", "/plan", "Create a plan for
  X", "plan for", "write a plan", "plan out", "implementation plan", "technical
  plan", or "design plan" — including when those words are buried in a longer
  prompt. Requires extensive in-repo AND external research. MUST finish with
  Cursor CreatePlan (Build button) plus a workspace research .md; never
  Write-only under .cursor/plans/. No TBD/stubs/deferred decisions.
  Anti-triggers: user already asked to implement/build now; orchestrator Plan
  phase already routed to planning.mdc LIGHT for a tiny enhancement; pure Q&A
  with no plan requested; seed thought / "deep dive:" → deep-dive; existing
  plan stress-test → review-plan.
---

# Create a plan

Cursor Plan Mode (2026): clarify → research the repo → reviewable plan → you
edit → **Build**. Delivery is **CreatePlan** (Build UI), not a `Write` to
`.cursor/plans/` alone. Routing: `_shared/plan-build-family.md`.

## Immediate action

1. Read `.cursor/rules/create-plan.mdc` and
   `references/cursor-native-plan.md`.
2. If not in **Plan mode**, switch (`SwitchMode` → `plan`) — CreatePlan / Build
   require it (`Shift+Tab`).
3. Do **not** claim done after writing only a workspace markdown file.
4. Do not implement unless the user clicks **Build** or explicitly asks.

## Workflow

### 0. Clarify (official Plan Mode step 1)

If the ask is underspecified in a way that would change design, ask **one
batch** of numbered questions and **stop until answered**. Minor ambiguity →
labeled assumption. Do not invent product choices.

### 1. Perceive — this repo first

Read `AGENTS.md` (Documentation map), owning docs, live code that will change
or be reused. Inventory existing primitives. Note hard constraints
(no-shortcuts, tool-exposure, KV, prompt registry, billing, size limits,
context-budget).

Evidence: **live code > owning docs > AGENTS.md > labeled assumption**.

### 2. Research externally (mandatory)

Do not lock a design from training-data guesswork. Write 3–6 search questions;
read primary sources (official docs, RFCs, vendor APIs). Cover SOTA, common
practice, pitfalls, standards, reference implementations.

Record a citations table (title + URL + takeaway). If SOTA conflicts with repo
invariants, choose explicitly (adapt or reject). Skipping research because
"we know the codebase" is a plan failure.

### 3. Frame

Problem · Outcome · In scope / Non-goals (each with why) · Success metrics.

### 4. Decide

For every non-trivial fork: ≥2 real alternatives (include one external
practice when it exists); mini-ADR; pick one. Prefer correct over convenient.

### 5. Specify

EARS requirements; Given/When/Then ACs; ban vague words (`fast`, `robust`,
`as needed`). Cover happy path, authz/validation, empty/boundary/idempotent/
concurrent/partial-failure, migrations, observability.

### 6. Decompose

Each `T-0N`: files, deps, acceptance, verification, wiring (routes, tools,
MCP/API, KV, prompts, docs/changelog). Tests and DoD rows are tasks **in this
plan**, not follow-ups.

### 7. Deliver + prove (not a self-grade)

1. **CreatePlan** — `name`, `overview`, `plan`, non-empty `todos` (one per
   `T-0N`). See `references/cursor-native-plan.md`.
2. **Research doc** — `Write` `references/plan-template.md` to
   `.cursor/plans/YYYY-MM-DD-<slug>.md`. Link it from the CreatePlan body
   (this is Cursor's "Save to workspace").
3. **plan-ban-sweep** — quote RECEIPT:

```bash
.cursor/skills/_shared/scripts/plan-ban-sweep.sh .cursor/plans/YYYY-MM-DD-<slug>.md
```

4. Isolated **`plan-checker`** (`readonly`, no `resume`). Same-session
   self-grade cannot close. FAIL → fix the plan, one recheck.

Prefer `/review-plan` before Build on non-trivial work. After review, refresh
CreatePlan so Build matches the approved plan.

If a later build misses intent: **revert, refine this plan, rebuild** — do not
patch a drifted agent (Cursor Plan Mode).

## Never do

- Finish with only `Write` to `.cursor/plans/*.md` (no CreatePlan / no Build UI)
- Ship `TBD` / stubs / "figure out during implementation"
- Claim "best practice" without a citation
- Skip external research or skip CreatePlan because the phrase was buried
- Call CreatePlan with empty `todos`
- Implement because research finished

## Pairs with

- skills: `review-plan`, `complete-the-build`, `review-build`, `deep-dive`,
  `planning-a-change`, `agentic-loop`, `running-a-dev-cycle`, `writing-tests`,
  `writing-an-adr`, `researching-a-dependency`, `task-topology`, `decompose`,
  `integrate`
- agents: `plan-checker`
- rules: `create-plan-rule`, `no-shortcuts`, `definition-of-done`,
  `regression-test`, `testing-conventions`, `implement-node-rule`
- refs: `references/cursor-native-plan.md`, `references/plan-template.md`,
  `_shared/plan-build-family.md`, `_shared/scripts/plan-ban-sweep.sh`
- commands: `plan` (`/plan`), `review-plan-cmd`, `review-build-cmd`
- workflows: `plan-then-build`, `build-as-graph`
- docs: `docs/plan-build-family.md`
