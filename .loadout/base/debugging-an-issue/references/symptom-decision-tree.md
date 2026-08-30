# Per-symptom decision tree

The first thing to try for common symptoms. This narrows where to look; it does not replace the
evidence-first loop in `SKILL.md` — confirm with evidence before you change behavior.

## Type errors

| Symptom | First thing to try |
| --- | --- |
| "Property X does not exist on type Y" | Find where `Y` is defined; is `X` actually on it? Did the input type drift from what the caller passes? |
| "Type A is not assignable to type B" | The two ends disagree. Read both definitions. Don't cast — fix the end that's wrong. |
| A type widened to `any`/`unknown` unexpectedly | Trace back to where inference was lost (an untyped boundary, a bad generic, a missing return type). Narrow there. |

## Test failures

| Symptom | First thing to try |
| --- | --- |
| Deep-equal / assertion diff | Read the actual-vs-expected diff line by line; the diff *is* the symptom. |
| Timeout | Likely an unresolved promise, a missing `await`, or a real timer where fake timers are needed. |
| "expected X, got undefined" | Trace where `undefined` was produced; usually an optional-chain or a missing field upstream. |
| Passes alone, fails in the suite | Test pollution / shared state. Find a missing reset (`beforeEach`, mock restore, module cache). |
| Passes locally, fails in CI | Environment difference: node/runtime version, timezone, env vars, ordering, or an uncommitted fixture. |

## Runtime errors

| Symptom | First thing to try |
| --- | --- |
| ReferenceError / "X is not defined" | A missing binding/import, or an env/config value not set in this environment. |
| Silent hang | A pending promise with no timeout, a lock not released, or an awaited event that never fires. |
| Null/undefined deref deep in a call | Find where the value was *supposed* to be set; the fix is usually upstream, not a guard at the crash site. |
| Out-of-memory / slowdown under load | Look for unbounded accumulation (arrays, caches, listeners) and N+1 data access. |

## API / integration

| Symptom | First thing to try |
| --- | --- |
| 400 | Read the error body — the provider tells you what's wrong. Compare your request shape to the docs. |
| 401/403 | Auth: missing/expired token, wrong scope, or a header not on this path. |
| 429 | Rate limited — add backoff or a permit; check the retry path is actually on the call. |
| Timeout | The dependency is slow; confirm the client timeout is reasonable and the call is retryable. |
| 5xx | Usually upstream — check the provider's status before changing your code. |

## When the tree doesn't help

If none of these fit, or two failed fixes have oscillated, stop guessing and escalate to
`root-cause-fix` (prove the cause) or `debugging-with-observability` (get runtime evidence).
