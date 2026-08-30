---
name: triaging-flaky-tests
description: Diagnose a flaky test with evidence and propose a real fix. Use when a test passes and fails non-deterministically.
---

# Triaging flaky tests

## Trigger

A test passes sometimes and fails other times with no code change.

## Workflow

1. **Confirm flakiness:** run it in isolation and in a loop (e.g. 20x). Record pass/fail counts.
2. **Find the source of non-determinism.** Common causes: shared/ordered state between tests, time/timezone, randomness without a seed, real network/clock, async race, leaked global, DB row ordering without `ORDER BY`.
3. **Stress the hypothesis:** run with random order, fake the clock, seed randomness, or isolate state — see which makes it deterministic.
4. **Fix the cause** (isolate state, inject the clock, await properly, order queries). Don't add sleeps or retries to hide it.
5. **Prove it:** the loop now passes consistently.

## Guardrails

- Don't `skip`/`retry` a flaky test as the fix; that hides a real race or shared-state bug.
- If you truly can't fix it now, quarantine it explicitly and file a ticket — don't leave it silently flaky.

## Pairs with

- rules: `testing-conventions`, `no-shortcuts`
- skills: `fixing-ci`, `debugging-an-issue`
