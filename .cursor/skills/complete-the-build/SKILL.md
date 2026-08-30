---
name: complete-the-build
description: >
  Exhaust a plan: inventory every phase, acceptance criterion, and deferral;
  build everything still Partial / Missing / Punted until the gap matrix is
  empty; prove with gates; hand off to review-build. Use when the user says
  "complete the build", "finish the plan", "close the gaps", "build out what's
  left", "another pass on the plan", "exhaust the plan", "we punted X — finish
  it", or when implementation stalled mid-plan and remaining work must be
  finished before review. Anti-triggers: ordinary forward implement without a
  gap inventory → keep implementing then `review-build`; claimed-done verify →
  review-build; session wrap → reviewing-and-shipping; release go/no-go →
  assessing-release-readiness; no plan yet → create-plan / review-plan;
  mid-session course-correct → deep-flight; session wrap + sibling hunt →
  post-flight.
---

# Complete the build

Implementation stalled, punted, or was marked "mostly done" while plan phases
remain open. Your job is to **build to an empty gap matrix**, not to review or
ship. Evidence over memory. Fix over deferral.

## Trigger

- A written plan exists (`.cursor/plans/`, `PLAN.md`, `docs/plans/…`, or an
  in-session plan the user named) and work against it is incomplete.
- Or the user explicitly asks to finish / exhaust / close gaps on a build.

Prefer this **before** `review-build` whenever any phase is Partial, Missing,
or Punted.

## Immediate action

1. Read the `complete-the-build` rule (`rules/complete-the-build.mdc`) end-to-end —
   hard bans live there.
2. Read `references/gap-matrix.md` and build the matrix **before coding**.
3. If no plan artifact exists and the user did not name acceptance criteria, ask
   for the plan path (or switch to `create-plan`) — do not invent a large
   exhaustion pass from memory.
4. Do **not** commit/push/PR unless the user explicitly asks.

## Workflow

### 1. Ground truth

```bash
git status
git diff <base>...HEAD
git diff
```

Locate the plan (user path, `.cursor/plans/`, `PLAN.md`, `docs/plans/`).
Re-read it top-to-bottom. Read `DECISIONS.md` / parking-lot entries / open
todos if present. State what you found before writing code.

### 2. Gap inventory (mandatory — no edits yet)

Produce the compliance matrix from `references/gap-matrix.md`. Rows cover:

- Every plan phase and task
- Every acceptance criterion
- Applicable `definition-of-done.mdc` rows for this change
- Discovered Issues / Future Improvements that are in-scope
- **Deferral inventory** — see `references/deferral-taxonomy.md`

Status per row: `Done` | `Partial` | `Missing` | `Punted` | `Out-of-scope`
(with reason). Print the matrix in the reply before the build loop.

If the matrix is already empty, say so and hand off to `review-build` — do not
invent work.

### 3. Work queue

Sort open rows:

1. P0 correctness / security / data-loss
2. Missing acceptance criteria
3. Partial / Punted implementation
4. Tests / DoD / docs / observability for in-scope behavior

Ban inventing new scope. Ban "skip for now" without a **survivor** row
(`references/deferral-taxonomy.md`).

### 4. Build loop

For each open row, one unit at a time (`agentic-loop` discipline):

1. Implement against the plan (existing patterns; no side quests).
2. Run the phase verify checklist — `references/phase-verify.md`.
3. Mark the row `Done` with file:symbol evidence.
4. Update the living plan (checkmarks, discovered issues) as you go.

This skill owns the **exhaustion contract** (gap matrix → empty).

### 5. Completeness re-pass

After the queue drains:

1. Re-walk the plan top-to-bottom and rebuild the matrix from evidence (not
   from the previous matrix copy).
2. Shortcut sweep — quote RECEIPT:

```bash
.cursor/skills/_shared/scripts/shortcut-sweep.sh
```

3. Walk applicable `definition-of-done.mdc` rows.
4. Run project gates (typecheck, affected package tests, lint, and any
   plan-named checks). **Paste output.** Fix until clean.

### 6. Convergence

Repeat steps 4–5 until **two consecutive** completeness re-passes show zero
`Partial` / `Missing` / `Punted` rows (survivors allowed only per taxonomy).

Circuit breaker — stop and ask the user if:

- Same error 3+ times with no progress
- Fixes keep breaking each other
- Meeting an AC requires architecture change not in the plan
- Security concern you cannot resolve correctly
- About to destroy unrecoverable data

### 7. Completion report + handoff

```markdown
# Build completion: <change name>

## Verdict

COMPLETE | COMPLETE WITH SURVIVORS | INCOMPLETE

## Gap matrix (final)

| #   | Plan item | Status | Location | Verified how |
| --- | --------- | ------ | -------- | ------------ |

## Built this pass

- …

## Survivors (or "none")

| Item | Survivor criterion | Logged at |
| ---- | ------------------ | --------- |

## Commands run

| Command | Outcome |
| ------- | ------- |

## Next

Ready for `review-build` (prefer a **fresh chat** — maker ≠ checker).
```

Edits stay unstaged unless the user asked to commit.

## What "done" means

- Gap matrix empty of Partial/Missing/Punted (survivors only with named
  criteria + log location)
- Two consecutive clean completeness passes
- Gates run with pasted evidence
- Explicit handoff to `review-build`

## Never do

- Code before the first gap matrix is published in the reply
- Silent deferrals ("follow-up", "noted for later") without a survivor row
- Jump to `review-build` while open rows remain
- Invent scope beyond the plan
- Claim COMPLETE from session memory without re-walking the plan
- Commit/push/PR unless explicitly asked

## Reference pointers

- `references/gap-matrix.md` — matrix template + row sources
- `references/deferral-taxonomy.md` — what counts as punted + survivor rules
- `references/phase-verify.md` — per-phase self-verify before marking Done

## Pairs with

- skills: `review-build`, `post-flight`, `create-plan`, `review-plan`,
  `agentic-loop`, `writing-tests`, `updating-docs`
- rules: `complete-the-build-rule`, `no-shortcuts`,
  `definition-of-done`, `regression-test`
- commands: `complete-the-build-cmd` (`/complete-the-build`), `review-build-cmd`
  (`/review-build`)
- workflows: `plan-then-build` (between implement and `review-build`)
