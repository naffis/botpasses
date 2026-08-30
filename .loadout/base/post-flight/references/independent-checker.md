# Independent checker — post-flight maker-checker gate

## Table of Contents

- [Purpose](#purpose)
- [When required](#when-required)
- [How to launch](#how-to-launch)
- [Checker brief (paste verbatim)](#checker-brief-paste-verbatim)
- [Checker outputs](#checker-outputs)
- [Maker reconciliation](#maker-reconciliation)
- [Stop / escalate](#stop--escalate)
- [Pointers](#pointers)

---

## Purpose

The maker that wrote the session's changes is biased toward justifying them.
**The maker must not be the sole checker.** This step is a fresh-context,
read-only adversarial pass that sees only the asks, the diff, and the maker's
matrices — not the maker's private rationale.

---

## When required

| Session content                                                                  | Checker                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| Any behavioral intent (bug fix, feature, skill/rule that changes agent behavior) | **Required** before CLEAN                |
| Pure docs / changelog / comment-only                                             | Skip with "docs-only — checker N/A"      |
| Mechanical refactor with characterization tests already green                    | Required if behavior could have snuck in |

Skipping the checker on behavioral work → post-flight cannot be CLEAN.

---

## How to launch

1. Finish maker Steps 0–8 so matrices are current.
2. Launch **`flight-checker`** (`readonly: true`). **Do not** pass `resume`.
   **Do not** pass the maker's internal reasoning — only the brief below.
3. A `generalPurpose` Task fed the maker's story is **not** a checker.
4. Native `/review` or `reviewer` may run **in addition**.

---

## Checker brief (paste verbatim)

```
You are the independent CHECKER for a post-flight. You did NOT make these changes.
You may NOT edit files. Report findings only.

## Ground truth (verbatim user asks)
{paste each user message that set/changed scope}

## Maker claims
- Requirements matrix: {paste}
- Fix-correctness matrix: {paste}
- Sibling sweep artifacts / negative attestation: {paste}

## Diff to grade
Run: git status --porcelain
Then read the FULL contents of every file this session owns (listed below).
Also run: git diff -- <session paths>

Session-owned paths:
{list paths}

## Grade against
1. Asked vs shipped — any partial/missing?
2. Fix-correctness — any bandaid / wrong-layer / unproven? Class-kill attestation complete for bug fixes?
3. Sibling sweep — pattern self-validated? Callers/entry points checked? same-class misses?
4. Shortcut catalog on session files (TODO/FIXME/type suppressions/swallowed catch/weakened tests)
5. DoD rows that should have fired
6. Anything the maker asserted without evidence in the matrices

## Output format
Verdict: PASS | FAIL
Findings (P0/P1/P2): each with path:evidence and why it fails
False-positive candidates: none, or list with why you'd dismiss
```

---

## Checker outputs

- **PASS** — no P0/P1; P2 optional notes allowed.
- **FAIL** — one or more P0/P1 with evidence.

A PASS with no quoted paths read / no command evidence is invalid — treat as
FAIL (checker theater).

---

## Maker reconciliation

| Checker result                     | Maker action                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PASS                               | Proceed to report CLEAN/FIXED                                                                                                                                           |
| FAIL with real P0/P1               | Fix now; re-run Steps 4–7 on fixes; **one** more checker round max                                                                                                      |
| FAIL, maker disputes               | Note dispute + evidence both sides; escalate to user (BLOCKED)                                                                                                          |
| Checker unreachable / tool failure | Same-session adversarial re-read; mark `checker: degraded-same-session`. **Cannot yield CLEAN** on behavioral work — BLOCKED until a real checker PASS or user accepts. |

---

## Stop / escalate

Budget: **1 maker clean pass + 1 checker round + at most 1 fix+recheck cycle**.
Still failing → **BLOCKED**. Do not polish forever.

---

## Pointers

| Doc                                                                 | Role                    |
| ------------------------------------------------------------------- | ----------------------- |
| `../../agentic-loop/references/subagents-and-parallelism.md`        | Maker-checker mechanics |
| `../../agentic-loop/references/verification-and-stop-conditions.md` | Stop = evidence         |
| `fix-correctness-audit.md`                                          | What Step 4 grades      |
| `sibling-surface-sweep.md`                                          | What Step 5 grades      |
