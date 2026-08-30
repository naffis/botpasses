# Fix-correctness audit — post-flight depth pass

## Table of Contents

- [Purpose](#purpose)
- [When this step applies](#when-this-step-applies)
- [Per-change classification](#per-change-classification)
- [Bug-fix / defect-class checklist](#bug-fix--defect-class-checklist)
- [Feature / behavior-change checklist](#feature--behavior-change-checklist)
- [Bandaid shapes to reject](#bandaid-shapes-to-reject)
- [Class-kill attestation (bug fixes)](#class-kill-attestation-bug-fixes)
- [Escalation](#escalation)
- [After this step](#after-this-step)
- [Pointers](#pointers)

---

## Purpose

Step 3's mechanical grep catches stubs and suppressions. This reference owns
the **semantic** question: for every intentional behavior change, was the
shipped solution the **correct root fix at the right layer**, or a proximate
patch that makes the specimen look done while the class survives?

---

## When this step applies

| Change type                                    | Depth required                                  |
| ---------------------------------------------- | ----------------------------------------------- |
| Bug fix / regression / "make X stop happening" | Full bug-fix checklist + class-kill attestation |
| Quality / gate / routing change                | Full bug-fix checklist (treat as defect class)  |
| New feature / UX / API                         | Feature checklist                               |
| Pure docs / comment / changelog-only           | Skip with "docs-only"                           |
| Mechanical refactor (behavior-preserving)      | Skip with "refactor — no behavior claim"        |

If unsure, run **both** checklists on that row.

---

## Per-change classification

One matrix row per **behavioral intent** (not per file). Group related hunks.

```
| # | Intent | Class / contract claimed | Layer pinned | Proximate rejected? | Sibling / failure covered? | Consumer traced? | Verdict |
|---|--------|--------------------------|--------------|---------------------|----------------------------|------------------|---------|
```

**Verdict values:** `class-kill` · `correct-feature` · `bandaid` · `wrong-layer`
· `unproven` · `n/a-docs` · `n/a-refactor`

---

## Bug-fix / defect-class checklist

Answer with short bullets and evidence paths:

1. **Symptom vs root.** User-visible failure? One-sentence root ("exists because
   **_, which causes _**")? If the root only names the session trigger, keep
   descending (`root-cause-fix` references).
2. **Layer pin.** Owning module/function/gate/contract. A UI/copy/prompt edit
   when a deterministic gate owns the class → `wrong-layer`.
3. **Counterfactual sibling.** One sibling input/path that would have hit the
   class before and must not after. Cannot name one → likely `bandaid`.
4. **Rejected proximate.** Cheapest patch considered (carve-out, swallow,
   special-case, test-only green) and why it fails the class test.
5. **Consumer path.** Callers that consume the changed contract — a green helper
   unit test alone is insufficient.
6. **Regression lock (hard for `class-kill`).** Test that **fails when the fix
   is reverted** (`regression-test`). Missing → at best `unproven`.
7. **Blast radius.** Inverse of the sibling still works?

---

## Feature / behavior-change checklist

1. **Contract.** Invariant encoded in a named function/type/API (not only copy).
2. **Right layer.** Data/rules in domain; HTTP at the route; presentation in UI.
3. **Failure paths.** Empty, unauthorized, not-found, timeout, partial batch —
   handled or explicitly out of scope with a visible error (no silent empty success).
4. **Happy-path-only?** Add at least one failure + one edge case.
5. **Papering.** Fallback defaults that hide a broken dependency → bandaid unless
   they emit structured failure and surface it.
6. **Asked scope only.** Extra behavior → justify or revert.

---

## Bandaid shapes to reject

| Shape                                                                   | Why it fails                  |
| ----------------------------------------------------------------------- | ----------------------------- |
| Special-case on one id / locale / provider                              | Instance-only                 |
| Regex / keyword carve-out that only steers this input off               | Trigger patch                 |
| Threshold / waive so bad output still delivers                          | Hides the class               |
| Swallow / return null / empty on error without structured signal        | Masks recurrence              |
| Fix the test or loosen the assertion instead of the producer            | Lies about quality            |
| Green unit test without consumer-path read                              | Asserted, not proven          |
| Prompt/config-only when a deterministic gate owns it                    | Wrong layer                   |
| Catch-and-retry / longer timeout as the only fix for a logic bug        | Proximate                     |
| Defensive check at the crash site while bad value is born upstream      | Symptom guard                 |
| "Follow-up" left for the class you already proved                       | Deferred bandaid              |

Standing rule: `no-shortcuts`.

---

## Class-kill attestation (bug fixes)

Before a bug-fix row can be `class-kill`, include all four:

1. **Class statement** — general failure class (no session id in the name).
2. **Counterfactual** — class impossible for every correct entry; name a sibling.
3. **Rejected proximate** — cheapest bandaid considered and why it fails.
4. **Consumer trace** — consuming path read; cite path:symbol.

Missing attestation → `unproven` → P0 until completed or escalated.

---

## Escalation

When the audit finds `bandaid` / `wrong-layer` / `unproven` that cannot be
repaired with a small correction:

1. Mark the requirements-matrix row ⚠️ / ❌.
2. Run `root-cause-fix` on that intent. Do **not** "improve" the bandaid.
3. After the class fix lands, re-run this audit on that row, then continue.

---

## After this step

A `class-kill` attestation names the counterfactual sibling in theory. Step 5
(`sibling-surface-sweep.md`) hunts the repo for real instances outside the
session diff.

---

## Pointers

| Doc                                                         | Role                          |
| ----------------------------------------------------------- | ----------------------------- |
| `no-shortcuts` rule                                         | Proximate-patch ban           |
| `sibling-surface-sweep.md`                                  | Similar issues outside diff   |
| `../root-cause-fix/SKILL.md`                                | Diagnose → class-fix          |
| `../root-cause-fix/references/root-cause-descent.md`        | Descent gates                 |
| `../root-cause-fix/references/solution-selection.md`        | Solution scorecard            |
| `regression-test` rule                                      | Fail-on-revert lock           |
