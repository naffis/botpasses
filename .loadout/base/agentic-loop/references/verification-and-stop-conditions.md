# Verification & stop conditions

An autonomous loop is trustworthy only if "done" *means* something. The most important thing
you write for a non-trivial task is the acceptance contract — the evidence the loop must
produce before it is allowed to claim success. Without it, the loop stops whenever it *feels*
finished, which is exactly when it is most likely wrong.

## 1. Write the stop condition as a contract

Four fields. Fill them before you start editing (put them in a `TodoWrite` item, a scratch
note, or the PR body):

| Field | What it pins down |
| --- | --- |
| **End state** | The concrete, observable target — a specific function's behavior, a passing gate, a produced artifact. Not "improve X". |
| **Evidence** | The command / artifact that PROVES the end state. Almost always: a green test + typecheck, a regression test that fails-on-revert, or an artifact you inspected. |
| **Constraints** | What must NOT change or be violated — no `any`, no public-API break, no new always-on rule, no touching an unrelated subsystem. |
| **Budget** | A hard ceiling — N edit->verify cycles, then escalate to the user rather than thrash. |

Weak vs verifiable:

- "make the parser better" -> "`parseDuration` accepts `'90m'`/`'1h30m'`/`'5400'` and returns
  seconds; the affected test file exits 0; the new case fails when the fix is reverted; no
  change to the public `Duration` type."
- "fix the flaky upload" -> "`uploadAsset` on the fixture returns a stable key; a regression
  test reproduces the old intermittent failure and now passes; no change to the public
  response shape."

## 2. The evaluator-optimizer loop

One pass generates a change, an *independent* pass evaluates it against the contract and feeds
back, and you iterate until the evaluation is clean. It works when (a) the criteria are clear
and (b) feedback demonstrably improves the result — exactly the case for code with tests. Two
guardrails:

- **The maker must not be the sole checker.** The model that wrote the code rationalizes its
  own diff. For shippable work, get an independent signal — the objective gates below, and a
  fresh reviewer sub-agent (see `subagents-and-parallelism.md`).
- **Bound the iteration.** Respect the budget field. If you're still red after the ceiling,
  stop and report what you tried and what's blocking — don't loop forever.

## 3. The red test / red gate is the honest signal

Treat a failing test, a typecheck error, or a red lint as the thing keeping the loop honest —
never something to suppress. Forbidden "green-by-cheating" moves (`no-shortcuts.mdc`,
`no-any.mdc`):

- weakening or deleting the test instead of fixing the code,
- `as any` / `@ts-ignore` (or the language equivalent) to silence a real type error,
- catch-and-swallow to make a throw disappear,
- hard-coded fallbacks that mask the real failure.

A regression test is mandatory for a bug fix (`regression-test.mdc`): it must **fail before**
your change and **pass after**. That fail-before step is the proof your fix addresses the real
cause, not a symptom.

## 4. The verification gates (the evidence toolbox)

Run these as the "observe" step of the loop — smallest scope first, widen as needed. Use the
project's real commands (discover them from `package.json` scripts, the CI config, or
`AGENTS.md`); the rows below are the *kinds* of signal, tool-neutral.

| Signal | How | When |
| --- | --- | --- |
| Type safety | the project's typecheck (scope to a package if it has them) | After any source edit |
| Unit / behavior | the affected test file, then the package/suite | After a logic change |
| Lints on your edits | your linter on the files you touched | After substantive edits |
| Regression proof | a new test, fails-on-revert | Every bug fix |
| Independent review | the `reviewer` agent (or a `bugbot`/`security-review` sub-agent) | Before presenting shippable work |

The full "what makes a change *done*" contract is `definition-of-done.mdc` — the repo-wide
acceptance test (behavior + tests + docs/changelog + any surface registration, in the SAME
change). Read it as the outer contract your task-level contract must also satisfy.

## 5. Verification is still on you

Even a green contract is a claim, not a guarantee of correctness:

- Green typecheck + green test proves *what you tested* passes — not that you tested the right
  thing. Confirm the evidence conditions actually capture the end state.
- Read the diff the loop produced. If you can't explain a change, you can't vouch for it —
  don't present it as done (comprehension debt).
- The independent checker reduces, but does not eliminate, self-review bias. Human review of
  the final diff stays in the path for anything that ships.

## Checklist

- [ ] Contract written (end state / evidence / constraints / budget) before editing?
- [ ] Evidence is an objective repo signal, not "looks done"?
- [ ] Regression test fails before the fix, passes after?
- [ ] No green-by-cheating (`any`, ignore-comments, swallowed errors, deleted assertions)?
- [ ] Typecheck + affected tests green?
- [ ] Independent checker ran on shippable work?
- [ ] Failure paths + one edge case covered, not just the happy path?
- [ ] `definition-of-done.mdc` rows for this change satisfied in the SAME change?
