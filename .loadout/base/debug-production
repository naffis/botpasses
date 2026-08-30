---
name: debug-production
uses:
  rules:
    [
      observability-first,
      no-secrets-in-code,
      regression-test,
      no-shortcuts,
      definition-of-done,
    ]
  skills:
    [
      debugging-with-observability,
      do-it-right,
      deep-flight,
      debugging-an-issue,
      root-cause-fix,
      writing-tests,
      reviewing-and-shipping,
    ]
  agents: [explorer, reviewer, flight-checker]
gate: "regression test fails-before/passes-after; project typecheck + test + lint green"
stop_condition: "root cause proven from runtime evidence, class fix landed, regression locked, reviewer verdict SAFE — or escalated with a written handoff"
state: ".loadout/state/debug-production.md"
---

# Debug production

Evidence-first recipe for a staging/production failure you cannot reproduce locally yet.
Unlike `debugging-an-issue` alone (everyday local bug) or `fix-ci-until-green` (PR checks),
this starts in telemetry, narrows to a component, then lands a proven class fix — not a
symptom patch.

1. **Frame the incident** — capture in the state file: symptom, user/impact, time window,
   environment, and every id you have (request/trace/run/session). Write the acceptance
   contract: what "fixed" means, what evidence proves it, and what you must not touch
   (prod data writes, secret rotation, gate-disabling). If blast radius is unclear or the
   fix may need a revert path, read the `hotfix-and-rollback` runbook before changing code.
2. **Read the signal first** — `debugging-with-observability`: get correlation ids → query
   logs/traces/metrics → interpret error shape, status codes, timing gaps → quote the exact
   line/span that names the failing component. Do **not** open source until a signal points
   somewhere. Never paste secrets/PII from telemetry into the diagnosis
   (`no-secrets-in-code`).
3. **Map only what's needed** — if the failing component is unfamiliar, dispatch `explorer`
   read-only for that slice (entry → logic → data/external call). Keep the main context on
   the evidence, not a tour of the whole repo.
4. **Narrow to a local repro** — turn the runtime signal into the smallest failing case.
   Prefer a failing test (`writing-tests` / `regression-test`). If you still can't repro
   locally, stay on the observability path: raise scoped debug briefly, catch the next
   occurrence, turn it back down — then continue.
5. **Everyday loop or class fix** — once you have a repro: `debugging-an-issue` for the
   falsify-hypotheses loop. If the user approved a shallow proposal ("yes, fix it" /
   "do it correctly"), run `do-it-right` **before** implementing. Escalate to
   `root-cause-fix` when the first two fixes fail, the defect is a class (sibling
   inputs would hit it), or the change will ship — prove the one true cause, fix
   the class, lock with a fail-on-revert regression test. After a non-trivial
   implement, run `deep-flight` before claiming done.
6. **Verify against ground truth** — run the `gate`. Confirm the regression test fails when
   the fix is reverted. If the original failure was live, re-check the same correlation-id
   path / metrics after deploy (or note that deploy verification is still pending).
7. **Maker ≠ checker** — dispatch the `reviewer` agent on the diff vs the incident contract
   and the proven cause. Reconcile real findings; ignore style nits.
8. **Ship or hand off** — `reviewing-and-shipping` only when the user asked to commit/PR.
   If the incident needs an immediate production action (flag flip, revert, surgical hotfix),
   follow `hotfix-and-rollback` — do not invent a parallel process. Leave the state file with
   cause, fix, evidence, and open follow-ups so the next session resumes cleanly.

Stop and escalate if: evidence contradicts every hypothesis after two honest cycles, the fix
needs a product/security decision the user owns, or verification can't be defined without
disabling a gate. Never widen a tolerance, delete an assertion, or "retry until green" to
force the stop condition.

Run the investigate→fix cycle as a verified loop (`agentic-loop`): stop contract from the
incident frame, ground-truth verify (regression + gate), maker ≠ checker before calling done.
