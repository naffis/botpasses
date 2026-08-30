# Solution gate — do-it-right Phase 2

## Table of Contents

- [Purpose](#purpose)
- [Generate distinct candidates](#generate-distinct-candidates)
- [Bandaid catalog (auto-reject)](#bandaid-catalog-auto-reject)
- [Scorecard](#scorecard)
- [100% sure gates](#100-sure-gates)
- [Chosen fix format](#chosen-fix-format)

---

## Purpose

A first solution idea is a **draft**. Phase 2 forces competing real options,
kills bandaids, and pins the correct layer before any production edit.

Deep doctrine (generation/quality):  
`root-cause-fix` + `no-shortcuts.mdc` Part 2.  
This file is the shorter gate for **any** domain (UI, API, heuristics, flags).

## Generate distinct candidates

For each confirmed issue, produce **≥2** candidates that differ in **layer or
contract**, not wording:

| Distinct                                           | Not distinct                              |
| -------------------------------------------------- | ----------------------------------------- |
| Trust `nsfw` flag vs remove name heuristic         | "Exclude `ads-static`" vs "Exclude `SFW`" |
| Server stamps content rating vs client guesses     | Two regexes on the same string            |
| Structured library filter vs title substring match | Threshold 0.7 vs 0.8 on the same score    |

If you only have one candidate, invent the next-deeper alternative (fix
authorship / contract / SoT) and the next-shallower (symptom patch) — then
**reject the shallow one on purpose** with a written reason.

## Bandaid catalog (auto-reject)

Reject immediately if the candidate is mainly:

- Keyword / substring / regex **exception** on a detector while the detector
  remains the SoT for a semantic decision
- Special-case carve-out for one product name, session title, or fixture
- Threshold / confidence / soft-ship nudge so bad state still ships
- "Exclude SFW … from the heuristic" when a structured SFW/NSFW signal exists
- Satisfy-the-audit waiver (silence one specimen; class survives)
- Catch-and-swallow, `as any`, disable lint/test to go green
- Dual write / shadow flag that leaves the wrong path live forever

Proximate patches may appear in the table as **Rejected** for teaching — never
as Chosen Fix when a class-kill exists.

## Scorecard

Score each survivor 1–5 on:

1. **Class-kill** — sibling brief / fixture in the class becomes impossible
2. **Correct layer** — owns the invariant (SoT), not a downstream guess
3. **Honesty** — no silent fallback; failures surface
4. **DoD fit** — tests, docs, owning-doc updates are feasible in this change
5. **Blast radius** — doesn't break the inverse case (true NSFW, true paid path…)

Leading candidate must win on (1) and (2). Ties → prefer deeper SoT.

## 100% sure gates

Before Chosen Fix:

1. Would a **new** caller that never saw this bug hit the same class? If yes and
   your fix is call-site only → wrong layer.
2. Does a structured signal already exist that you're ignoring? Prefer it.
3. Is this the same shape `no-shortcuts.mdc` bans for quality defects? If yes,
   reject even outside video pipelines.
4. Can you name one regression test that fails when the fix is reverted?

## Chosen fix format

Print before editing:

```
### Chosen fix — <issue title>
- Layer / symbol:
- Why this kills the class:
- Inverse still correct because:
- Rejected:
  - A: … (why)
  - B: … (why)
- Implement via: root-cause-fix | debugging-an-issue | inline (this skill)
```

No Chosen Fix block → no code.
