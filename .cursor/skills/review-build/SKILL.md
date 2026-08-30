---
name: review-build
description: >
  Review implemented work as a skeptical staff engineer seeing it for the first
  time. Use when the user says "Review the build", "review this build",
  "review-build", "review the implementation", "did we build what we planned",
  or asks to verify a finished change against a plan or original request.
  Evidence over assertion: git diff, plan/requirement trace, shortcut sweep,
  gate commands with pasted output, fix blockers/majors, final report.
  Anti-triggers: review a plan before coding → review-plan; open plan phases
  still Partial/Missing/Punted → complete-the-build first; wrap up and ship →
  reviewing-and-shipping; ordinary code-quality audit → reviewing-code-quality;
  end-of-session maker fix-mode (sibling sweep + deferred work) → post-flight;
  mid-session course-correct → deep-flight.
---

# Review a build

## Trigger

Implementation is claimed done (or nearly done) and needs an adversarial,
evidence-first check before shipping — especially after `plan-then-build`, or
when the stakes are high enough that the author re-reading themselves is not
enough. Prefer a fresh chat when possible (maker ≠ checker).

## Immediate action

1. Read the `review-build` rule (`rules/review-build.mdc`) end-to-end — it is
   the full standard.
2. Execute every step. **Fix blockers and majors in the code** — chat-only
   critique without repairs is a failure for those severities.
3. Do **not** commit/push/PR unless the user explicitly asks.

## Workflow

### 1. Ground truth first

Run against the base branch (or the user's named base) and review the actual
diff, not your memory of making it:

```bash
git status
git diff <base>...HEAD
# also unstaged / uncommitted work:
git diff
```

Re-open any file you are unsure about. Cite paths (and lines when it matters).

### 2. Trace the plan or original request

Map every requirement and every plan step to where it is implemented (file and
line). List every deviation from the plan; fix it or justify it in the report.

If there is no written plan, trace against the original user request and any
acceptance criteria stated in-session.

If the trace shows material **Partial / Missing / Punted** plan rows still open,
**stop reviewing** and hand off to `complete-the-build` (`/complete-the-build`)
— reviewing an unfinished build is the wrong job. Resume this skill after the
gap matrix is empty.

### 2b. Unit boundary check (when a task graph exists)

If `.loadout/tasks/<slug>/TASK.md` (or the plan's topology section) declares
pipeline/graph units with file allowlists:

1. For each unit, compute `git diff` paths attributable to that unit (or the
   integrated diff sliced by allowlist).
2. **PASS** only if every edited path is ⊆ that unit's allowlist (contract file
   read-only; edits to the contract outside a decompose pass are a failure).
3. Report breaches as **blocker**s: boundary violations mean the graph contract
   was not followed — fix by reverting the out-of-allowlist edit or recording an
   explicit topology amendment (re-decompose), not by ignoring it.
4. Also check the classic parallel failure: units each "pass" but disagree on the
   shared contract's meaning (`integrate` § spec review).

Skip this step only when topology is single-loop or no task file/plan topology
exists.

### 3. Shortcut sweep (script, not vibes)

```bash
.cursor/skills/_shared/scripts/shortcut-sweep.sh
```

Quote the `RECEIPT`. Triage hits; fix or justify. A sweep with no RECEIPT was skipped.

### 3b. Isolated checker

Launch **`flight-checker`** (`readonly`, no `resume`). Native `/review` may run in addition. Same-session self-grade cannot yield PASS.

### 4. Run the verification gate

Run every verification the project documents (typecheck, lint, tests, build —
whatever `AGENTS.md` / CI / the plan's test plan names). Paste the actual
output. If anything fails, fix it and re-run until clean. A pass you did not
paste does not count.

### 5. Correctness pass

On each changed file, check:

- Error handling on new paths
- Edge cases: empty/null input, concurrency, partial failure, idempotency
- Security on any new input, endpoint, or query
- Behavior changes outside the task's scope (cut or justify)

### 6. Findings → fix → re-verify

List findings numbered with severity:

| Severity    | Meaning                      | Action                               |
| ----------- | ---------------------------- | ------------------------------------ |
| **blocker** | Wrong, unsafe, or unverified | Fix now; re-run step 4               |
| **major**   | Likely bug or plan miss      | Fix now; re-run step 4               |
| **minor**   | Quality / clarity            | Fix if cheap; else leave with reason |

Do not invent findings to appear thorough, and do not skip checks to appear
done. Both are failures.

### 7. Final report

```markdown
# Build review: <change name>

## Verdict

PASS | PASS WITH NOTES | FAIL

## Requirement / plan trace

| Requirement or plan step | Implemented at | Status |
| ------------------------ | -------------- | ------ |

## Unit boundaries (if task graph)

| Unit | Allowlist | Diff paths outside allowlist | Status |
| ---- | --------- | ---------------------------- | ------ |

## Deviations from plan

## Shortcut sweep hits → fixed or justified

## Commands run

| Command | Outcome |
| ------- | ------- |

## Findings found → fixed

## Left open (with reason) — or "none"
```

## What "done" means

- Diff reviewed from ground truth; plan/request fully traced
- Shortcut RECEIPT quoted; `flight-checker` PASS; blockers and majors fixed
- Gate commands run with pasted evidence
- Verdict explicit; report in the reply
- Edits left unstaged unless the user asked to commit

## Never do

- Rubber-stamp from memory of writing the code
- Claim green without pasting command output
- Skip the shortcut sweep or the plan trace
- Ship with unresolved blockers/majors
- Commit/push/PR unless explicitly asked

## Pairs with

- skills: `review-plan`, `create-plan`, `complete-the-build`, `post-flight`, `reviewing-and-shipping`,
  `deslopping`, `simplifying-code`, `writing-tests`, `reviewing-code-quality`,
  `task-topology`, `integrate`
- rules: `review-build-rule`, `no-shortcuts`, `definition-of-done`,
  `regression-test`, `testing-conventions`, `implement-node-rule`
- agents: `flight-checker` (required), `reviewer`, `security-reviewer`,
  `implement-node`
- refs: `_shared/plan-build-family.md`, `_shared/scripts/shortcut-sweep.sh`
- commands: `plan` (`/plan`), `review-plan-cmd` (`/review-plan`),
  `complete-the-build-cmd` (`/complete-the-build`),
  `review-build-cmd` (`/review-build`), `post-flight-cmd` (`/post-flight`)
- workflows: `plan-then-build`, `ship-a-feature`, `run-autonomous-loop`, `build-as-graph`
