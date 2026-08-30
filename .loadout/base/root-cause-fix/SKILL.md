---
name: root-cause-fix
description: >
  Iterative Root Cause -> Correct Fix engine for a DEFINED issue: prove the true root cause
  (Loop A -- hypothesis->evidence until ONE cause explains 100% of the behavior), converge on
  a generalized no-bandaid fix for the whole failure CLASS not just the repro (Loop B --
  propose->self-attack->refine), then IMPLEMENT it at the root layer and lock it with a
  regression test (fails before, passes after) + green typecheck/tests. Triggers on "fix this
  issue", "find the root cause and fix it", "diagnose and fix", "root cause fix", "fix it
  properly", "analyze and fix". Anti-triggers:   a quick everyday red-test bug ->
  debugging-an-issue; user said "yes / do it correctly" after a shallow proposal ->
  do-it-right first; investigation-only with no fix -> debugging-an-issue; a production
  issue with no local repro -> debugging-with-observability first; running the whole task
  as a loop -> agentic-loop.
---

# Root cause -> correct fix (iterative)

You are a senior debugging engineer. Your job is NOT to make the symptom disappear as fast as
possible. It is to find the _true_ root cause, prove it is the only one, ship a fix that
resolves the **entire class** of failure (not just this reproduction), and **lock it with a
regression test**.

This is a **loop, not a checklist.** You cycle hypothesis -> evidence -> revised understanding
until the explanation is stable and complete, then cycle proposed fix -> self-attack ->
refinement until the fix covers every case. Stopping at the first plausible cause is the most
common way to ship a wrong fix. Keep looping until the exit criteria are truly met.

> **Loop discipline.** This skill IS an agentic loop. Its framing levers — a stop-condition
> **contract**, a managed **context budget**, and an independent **checker separate from the
> maker** — are owned by the `agentic-loop` skill. Read it for the general depth. Two levers
> are wired in explicitly below: the acceptance **contract + budget** (Crystallize step 5) and
> the **maker-checker** (Implement step 5).

## When to use vs. the neighbours

| Use this skill                                                                      | Use instead                        |
| ----------------------------------------------------------------------------------- | ---------------------------------- |
| "Find the real root cause of this issue and fix it properly (for the whole class)." | —                                  |
| User said "yes / do it correctly" after a shallow proposal — dig-deeper gate first  | `do-it-right` (then hand off here) |
| A quick everyday bug (red test, typecheck failure, wrong value) — fast repro->fix   | `debugging-an-issue`               |
| A production/staging issue with no local repro — get runtime evidence first         | `debugging-with-observability`     |
| Structuring the whole task as a verified loop                                       | `agentic-loop`                     |

This skill OWNS the implement step the others stop short of: it diagnoses to a proven root
cause (or accepts one already proven), selects a no-bandaid generalized fix, **applies it**,
and **proves it** with a regression test under `regression-test.mdc` / `no-shortcuts.mdc` /
`definition-of-done.mdc`.

## Operating rules (hold these throughout every loop)

1. **No fix until the root cause is proven.** Do not edit or suggest code during diagnosis.
   Diagnose first.
2. **Evidence over intuition.** Every claim about cause is backed by the actual code, data,
   types, logs, or a reproduction — never by what you assume the code "probably" does. Read
   the real files. Follow the real call path. Don't theorize about state you could go read.
3. **Symptom != cause.** The line that throws is almost never the root. Trace upstream to
   where the wrong state, value, or assumption was first born.
4. **One fix per root-cause class; generalize.** If the fix only works for this exact
   reproduction, it is wrong.
5. **Be honest about uncertainty.** If you can't prove it, say so and state exactly what
   evidence or repro is still missing.

## Step 0 — Frame the problem

- Observed vs. expected behavior.
- Exact trigger conditions (inputs, state, env, timing, ordering) — and what does NOT trigger
  it. The contrast is a clue.
- Minimal deterministic repro if possible; if not, state what's needed to get one.
- **Seed the hypothesis list:** every cause that could plausibly produce this. Aim for >=3.
  Mark each "unverified."

## Loop A — diagnosis loop -> converge on the proven root cause

```
while (root cause NOT proven):
    pick the strongest UNVERIFIED hypothesis
    gather REAL evidence for it      # read code, inspect actual values/types,
                                     # trace data across the suspect boundary:
                                     # async, cache, config, ordering, nil/empty,
                                     # off-by-one, race. Reproduce/instrument if needed.
    confirm | eliminate (cite the evidence that kills it) | refine
    if confirmed: ask "why?" and SPAWN a deeper hypothesis for the next layer
    update: what is now explained vs. still unexplained
```

**Exit the loop ONLY when all hold:**

- A single root cause (or a complete set of contributing causes) mechanically explains
  **100%** of observed behavior — every symptom, including odd/intermittent/secondary ones.
  Any unexplained detail means an undiscovered cause -> keep looping.
- Every competing hypothesis is eliminated by **evidence, not preference.** Answer explicitly:
  _"If another root cause existed, what would I expect to see — and have I checked for it?"_
- Could **multiple independent causes** each be partly responsible? If untested, loop again.
- The next "why" leaves this system (a genuine external constraint/contract).

If you keep cycling with no new evidence, you've hit an information wall — stop guessing and
**change approach**: add logging, obtain the missing input, or build the repro. Say so.

**Loop A output:** root cause in one sentence — \*"The bug exists because **_, which causes _**"\*
— plus the causal chain with evidence, and the alternatives you ruled out and how.

> The deeper gate catalog this loop relies on — the five "are we sure?" gates (completeness,
> counterfactual, depth probe, class test, controllability), alternative-hypothesis
> elimination, stop conditions, and consolidation of symptoms that share one root — lives in
> `references/root-cause-descent.md`. Use it; do not re-derive it.

## Loop B — solution loop -> converge on the correct, generalized fix

```
while (fix NOT proven correct & general):
    state the CORRECT behavior at the level of the root cause
        (independent of the specific failing input)
    propose a fix that removes the root cause for the WHOLE class
        (all inputs / paths / timings / environments sharing the flaw)
    ATTACK your own fix:
        - does any sibling variation of this bug still slip through?   -> band-aid, reject
        - is it special-casing this value / swallowing the error /
          guarding only at the crash site?                            -> reject; name what
                                                                          you're dodging
        - blast radius: what depends on this code? does it break any
          adjacent valid case? which invariants must it preserve?
    refine
```

**Exit only when** the fix eliminates the _proven_ root cause, covers every case in the class,
and breaks nothing adjacent. If there's genuine tension (correctness vs. scope vs. risk),
surface the options with trade-offs and recommend one — don't silently pick the narrow one.

> Generate >=3 distinct-MECHANISM candidates and score them on the scorecard in
> `references/solution-selection.md` — **Correctness** and the **Bandaid test** are pass/fail
> gates; cost is only a tie-breaker. Auto-reject the bandaid catalog (special-casing a value,
> threshold nudges, swallowed errors / silent fallbacks, fixing the gate not the code). Run
> the "100% sure?" gates on the winner. The mandatory candidate #1 is the smallest change to
> the EXACT node the root named.

## Crystallize the fix (before writing any fix code)

State the converged solution clearly and concretely:

1. **Root cause** — one sentence, and the **principle** the fix establishes.
2. **The fix** — what changes, at what layer, and why that's the right level (the cause, not
   the symptom).
3. **Why it generalizes** — the full set of cases it now covers.
4. **Validation** — the original repro passes _plus_ the sibling variations that share the
   cause; and the regression test to add to lock it in.
5. **Acceptance contract (the stop condition — write it before editing).** Four fields, per
   `agentic-loop` / `verification-and-stop-conditions.md`:
   - **End state** — the observable corrected behavior, not "the defect is gone".
   - **Evidence** — the regression test that **fails-on-revert** + the project's typecheck +
     the affected test suite green.
   - **Constraints** — no `any`/ignore-comments/swallowed errors, no public-API break, no new
     always-on rule, no regression to untouched behavior.
   - **Budget** — a hard ceiling of edit->verify cycles (default **3**). At the ceiling, STOP
     and escalate with what you tried + the blocking evidence — never thrash, widen a
     tolerance, or ship a bandaid to force green.

Do not write fix code until Loop A has converged and the root cause is proven.

## Implement & verify (the step the analysis skills stop short of)

Now — and only now — apply the crystallized fix. Governed by `no-shortcuts.mdc`,
`regression-test.mdc`, `definition-of-done.mdc`:

1. **Change the root node, not the symptom site.** Edit the exact file/function/branch the
   root cause named. No ignore-comments, no casts to silence a real error, no swallowed
   errors, no threshold nudge, no special-case — those are auto-reject. If the correct fix is
   large, do the large fix; difficulty is not a reason to narrow it.
2. **Write the regression test FIRST-or-alongside** (`regression-test.mdc`): a test that
   **fails on the pre-fix code and passes after** — asserting the corrected behavior for the
   CLASS (the repro + >=1 sibling variation), not just the one input. Confirm it red before
   the fix, green after.
3. **Satisfy the Definition of Done** for what you touched: typecheck + the affected tests
   green; if the change alters behavior/defaults/public surface, add the docs/changelog and
   any surface registration IN THE SAME CHANGE. No "follow-up".
4. **Re-prove the original repro** is resolved, and the siblings too.
   **4b. Trace the CONSUMING code path end-to-end — a green unit test of the changed function
   is necessary, NOT sufficient.** The fix changes a value/branch; now read the downstream
   code that CONSUMES it and confirm the defect is actually impossible for the class, not
   merely that the function returns the new value. Does the consumer use this output the way
   the fix assumes? Is the path even reached for the failing input? "It returns the right
   value now" != "the behavior is fixed."
5. **Independent checker — the maker is not the sole checker (`agentic-loop`).** For a
   shippable or high-severity fix, hand the **diff + the acceptance contract** to a
   FRESH-context checker (the `reviewer` / `security-reviewer` agent, or a Cursor `bugbot` /
   `security-review` sub-agent, launched read-only). It re-runs the tests, reads the diff
   against the contract + repo conventions, and returns a verdict with evidence per finding.
   Reconcile: a real finding loops back to the maker (within the budget); a false positive is
   dismissed with a stated reason. Skip only for a trivially-scoped fix whose regression test
   - consumer trace (4b) already make the class impossible — and say why you skipped.
6. **Git safety:** leave edits unstaged for review; do not commit/push/branch/PR unless the
   user explicitly asks (`commit-and-pr-conventions.mdc`). Autonomy applies to edit-and-verify,
   never to git.

If implementation surfaces evidence that the root cause was wrong (the fix doesn't resolve the
repro, or a sibling still fails), STOP — return to Loop A with the new evidence. A fix that
doesn't kill the repro is a falsified root cause, not a fix to patch.

If you reach the contract's edit->verify **budget** ceiling (default 3) without a green
contract, STOP and escalate with what you tried + the blocking evidence. A fix that won't
converge within the budget is a signal to re-open Loop A or surface a scope/architecture
decision the user owns — never to keep patching or delete an assertion to force green.

## Output — the fix report

```markdown
# Root-cause fix — <issue>

## Root cause (proven)

"The bug exists because **_, which causes _**." + the principle the fix establishes.
Causal chain: proximate -> ... -> ROOT (evidence per link).
Alternatives ruled out: [A, B + the evidence that killed each].

## The fix

- Layer/node changed: <file . function . branch> (the cause, not the symptom)
- What changed + why this is the right level.
- Why it generalizes: <the full class of cases now covered>.
- Root-node candidate shown + why chosen over the cheaper bandaid (named).
- Blast radius: <what else touches this path; invariants preserved; adjacent cases safe>.

## Validation

- Acceptance contract: end state . evidence . constraints . budget — all met (cycles: N/3).
- Regression test: <path> — fails on pre-fix code, passes after; covers repro + siblings.
- Gates: typecheck OK . affected tests OK
- Independent checker: <reviewer/bugbot> — verdict (or findings reconciled), or "skipped: <why>".
- Definition-of-Done rows satisfied: <changelog / docs / surface, or N/A + why>.
- Edits left UNSTAGED; no commit/push unless the user asked.

## Residual / uncertainty

[Anything not proven, or a deliberately surfaced correctness-vs-scope trade-off + recommendation.]
```

## Common pitfalls

- **Fixing before the cause is proven.** Diagnosis and editing are separate phases; Loop A
  must converge first.
- **Stopping at the first plausible cause.** The first reason is almost always proximate. Keep
  asking "why?" until the next "why" leaves the system.
- **Leaving a symptom unexplained.** If any odd/intermittent detail isn't explained by your
  root cause, there is another cause — keep looping.
- **A fix that only passes the one repro.** That is a band-aid by definition. Cover the class;
  prove it with a sibling-variation test.
- **Guarding only at the crash site / swallowing the error / nudging a threshold /
  special-casing this value.** Auto-reject — name what you're dodging and fix the deeper cause.
- **No regression test.** An un-locked fix silently regresses later; the test that fails
  before and passes after IS the proof.
- **Letting the maker be the sole checker.** On a shippable fix, green gates from the same
  context that wrote the fix is self-review, not proof.
- **Claiming a fix works from a unit test alone, without tracing the consumer** (Step 4b).

## Pairs with

- skills: `debugging-an-issue`, `do-it-right`, `agentic-loop`, `reviewing-and-shipping`,
  `post-flight`, `debugging-with-observability`
- rules: `regression-test`, `no-shortcuts`, `definition-of-done`
- agents: `reviewer`, `security-reviewer`
- workflows: `run-autonomous-loop`, `debug-production`, `security-pass`
- runbooks: `hotfix-and-rollback`
