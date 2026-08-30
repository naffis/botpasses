# Sibling / similar-issue surface sweep — post-flight

## Table of Contents

- [Purpose](#purpose)
- [Scope discipline](#scope-discipline)
- [Risk tiers / recon scout](#risk-tiers--recon-scout)
- [How to derive the hunt](#how-to-derive-the-hunt)
- [Pattern self-validation (mandatory gate)](#pattern-self-validation-mandatory-gate)
- [Search dimensions](#search-dimensions)
- [Read depth (not just grep)](#read-depth-not-just-grep)
- [Triage of hits](#triage-of-hits)
- [Required artifacts](#required-artifacts)
- [Stop conditions](#stop-conditions)
- [Pointers](#pointers)

---

## Purpose

Steps 2–4 audit **what this session changed**. This sweep asks:

> Given the defect class / contract / pattern we just touched, where else in
> the codebase does the **same shape** still exist — including paths the
> session never opened?

Missed siblings are how "we fixed it" becomes "it broke again next week on
the other entry point." Callers and entry points dominate misses — clone search
alone is not enough.

---

## Scope discipline

- **In scope:** same failure class, same wrong trade, same missing guard, same
  incomplete wire, same API shape on a parallel surface — even if not in
  `git status`.
- **Out of scope:** unrelated tech debt, drive-by refactors (`refactor-discipline`).
- **Bounded fan-out:** hunt per risk tier. Do not boil the ocean; do not skip
  because the diff was small.

Fixing a confirmed sibling of **this session's class** is in-scope P0/P1.

---

## Risk tiers / recon scout

| Tier  | When                                                                 | Hunt depth                                                    |
| ----- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| **A** | Docs / changelog / comment / pure meta with no agent-behavior change | Skip hunt; write "Tier A — N/A"                               |
| **B** | Single-package logic, one entry point                                | Dimensions **1–4** mandatory; 5–8 if recon finds ≥1 candidate |
| **C** | Multi-package, multiple entry points, or skill/rule that changes agent behavior | All **8** dimensions; independent checker required |

**Recon scout:** after pattern self-validation, cheap candidate count:

| Candidates | Report shape                                        |
| ---------- | --------------------------------------------------- |
| 0          | Negative attestation (one paragraph)                |
| 1–5        | Inline findings table + triage each                 |
| 6+         | Full hunt plan + receipts + table; riskiest first   |

---

## How to derive the hunt

For each Step 4 behavioral intent (skip `n/a-docs` / `n/a-refactor`):

1. **Name the class** — one sentence, no session id.
2. **Name the mechanism** — wrong/fixed trade in code terms.
3. **Extract hunt keys** — symbols, literals, schema fields, routes, events,
   predicate names, mirror package paths.
4. **List expected parallel surfaces** before grepping (hypothesis list ≥3
   when Tier C):
   - Other callers of the same helper (**priority #1**)
   - Sibling routes / tools / admin / legacy entry points
   - Mirror UI that reads the same DTO
   - Tests that encode the old broken contract
   - Sibling skills/rules that claim the same completeness job (meta work)

Then **self-validate the pattern**, then search.

---

## Pattern self-validation (mandatory gate)

Never scan with a misread pattern.

1. From `git diff` (or `git show HEAD:path` for removed lines — **never stash**),
   extract the **anti-pattern** — the distinctive pre-fix shape.
2. **Validate:** the anti-pattern must match the pre-fix version of at least
   one session-touched file. If not, refine or abort — do not scan with a bad pattern.
3. Record: `pattern: {summary}` · `validated against: {path}` · `match: yes`.
4. Validation fails twice → mark Step 5 `unproven-pattern` (P0); do not fake a
   negative attestation.

For **feature** intents: validate that the **new invariant predicate** is what
you will grep for absence of. Validation = the new symbol exists in the session
diff and has ≥1 real caller or export.

---

## Search dimensions

Record each query + hit count (including 0). Do 1–4 before clone-ish 5:

| #   | Dimension                    | What to do                                                                 |
| --- | ---------------------------- | -------------------------------------------------------------------------- |
| 1   | **Symbol fan-out / callers** | Grep changed exports/predicates. Open **every** caller outside the diff.   |
| 2   | **Entry-point matrix**       | Every way a user/operator hits this behavior.                              |
| 3   | **Parallel packages**        | Domain ↔ API ↔ web ↔ worker/agent.                                         |
| 4   | **Literal / semantic twins** | Distinctive strings **and** "should call the new predicate but doesn't".   |
| 5   | **Near-duplicate files**     | Adjacent handlers, copy-pasted tests. Secondary.                           |
| 6   | **Inverse / opposite mode**  | Opposite flag/mode that should still work (or share the invariant).        |
| 7   | **Historical twins**         | `git log -S'<symbol>' --oneline` / changelog for the same class.           |
| 8   | **Test asymmetry**           | Mirror surface missing an equivalent fail-on-revert regression.            |

---

## Read depth (not just grep)

For each plausible hit:

1. Read the full function / handler.
2. Would the **pre-fix** bug reproduce here with a sibling input?
3. Did our fix's invariant get applied, a weaker local guard, or nothing?
4. Trace one level of callees if the hit is a thin wrapper.
5. Note whether a regression would fail-on-revert for **this** surface too.

---

## Triage of hits

| Verdict                    | Meaning                                       | Action                                      |
| -------------------------- | --------------------------------------------- | ------------------------------------------- |
| `same-class`               | Same root trade / missing invariant           | **P0** — fix now; extend regression         |
| `partial-port`             | Weaker or incomplete version of the fix       | **P0/P1** — complete the port               |
| `adjacent-valid`           | Looks similar but correctly different         | Not a finding (one-line why)                |
| `pre-existing-other-class` | Real bug, different class                     | Log; do not silently expand scope           |
| `false-positive`           | Grep noise                                    | Discard with one-line why                   |

Confirmed `same-class` / `partial-port` expand the Step 1 matrix and must be
fixed before CLEAN.

---

## Required artifacts

1. **Tier + recon** — A/B/C and candidate bucket (0 / 1–5 / 6+).
2. **Pattern validation** — summary · validated path · match yes/no.
3. **Hunt plan** — class · mechanism · hunt keys · hypothesized surfaces.
4. **Search receipts** — queries + hit counts (incl. 0).
5. **Sibling findings table** (or negative attestation).

```
| Intent # | Surface (path:symbol) | In session diff? | Verdict | Action |
|----------|----------------------|------------------|---------|--------|
```

6. **Negative attestation** — if zero siblings: "Tier {X}; pattern validated
   against {path}; searched {dimensions}; no same-class hits outside the
   session diff."

---

## Stop conditions

Stop the hunt for an intent when pattern validation passed (or Tier A skip),
tier-required dimensions ran, every non-noise hit was triaged, and either ≥1
`same-class`/`partial-port` is queued for fix **or** negative attestation is written.

---

## Pointers

| Doc                                  | Role                                              |
| ------------------------------------ | ------------------------------------------------- |
| `fix-correctness-audit.md`           | Class naming + attestation this sweep extends     |
| `independent-checker.md`             | Fresh-context grade of this sweep                 |
| `../root-cause-fix/SKILL.md`         | Escalate when siblings prove the fix was proximate |
| `no-shortcuts` rule                  | No "fix only the open file"                       |
| `refactor-discipline` rule           | Don't boil the ocean while hunting                |
