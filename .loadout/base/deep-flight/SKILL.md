---
name: deep-flight
description: >
  Mid-session in-flight quality gate after substantial edits, before claiming
  done. Use when the user says "deep-flight", "deep flight", "in-flight check",
  "are we still doing this right", "course-correct", "don't drift", "check the
  layer", or when do-it-right implementation is underway and verification has
  not been proven. Confirms the chosen layer still holds, runs the shortcut
  script, quotes gate output, then a readonly flight-checker. Fixes drift now.
  Anti-triggers: seed thought / "deep dive:" → deep-dive; "yes, fix it" before
  any Chosen Fix → do-it-right; session wrap / sibling sweep → post-flight;
  plan-vs-build grade → review-build.
---

# Deep-flight — in-flight course-correct

You are **mid-build**. Prove the work is still on the class-kill path and
**fix drift now** before anyone claims done.

Not `deep-dive` (recommend only). Not `post-flight` (full wrap + sibling hunt).
Routing: `_shared/flight-family.md`.

## Immediate action

1. Read `_shared/flight-family.md` if routing is unclear.
2. Do **not** declare ON-COURSE from memory.
3. Do not commit/push/PR unless the user explicitly asks.

## Workflow

### 1. Frame

- **Ask** — verbatim user outcome still in force.
- **Chosen layer** — file:symbol you said you would change. None → stop and
  run `do-it-right`.
- **In-flight diff** — `git status --porcelain` + `git diff --stat`. Session
  paths only on a shared dirty tree.

### 2. Layer still correct?

For each behavioral intent: name the class; confirm the edit is at the owning
layer. Heuristic carve-out / threshold nudge / satisfy-the-audit waiver →
**P0**. Escalate to `do-it-right` or `root-cause-fix`. Do not polish the
bandaid.

### 3. Mechanical sweep

```bash
.cursor/skills/_shared/scripts/shortcut-sweep.sh
```

(Loadout checkout: `plugins/core-engineering/skills/_shared/scripts/shortcut-sweep.sh`.)
Quote the `RECEIPT`. Session-introduced hits → fix now.

### 4. Verification evidence

Run the project's documented gates (`AGENTS.md` / CI / plan test plan) for
packages the diff touches. **Paste closing lines.** "Will verify later" is
drift.

### 5. Isolated checker

Launch **`flight-checker`** (`readonly: true`, no `resume`, omit `model`).
Give verbatim asks, session paths, Chosen layer, RECEIPT, quoted gates.
No private rationale. Native `/review` may run in addition.

FAIL → fix P0/P1, re-run steps 3–4, **one** recheck. Still failing →
**OFF-COURSE**. Same-session degrade cannot yield ON-COURSE.

### 6. Course-correct

P0/P1 now. No sibling-surface hunt (that is `post-flight`). If wrapping the
session, hand off to `post-flight` after ON-COURSE.

## Report

```
## Deep-flight report
**Verdict:** ON-COURSE / CORRECTED (N) / OFF-COURSE
- Ask still in force:
- Chosen layer (file:symbol):
- Layer still correct? yes / no → {handoff}
- Shortcut RECEIPT: quoted / missing
- Gates: {quoted closing lines}
- flight-checker: PASS / FAIL / blocked
- Drift fixed:
- Residual: none | {item + why it survives}
```

## Never do

- Treat this as `deep-dive` or skip it because post-flight will catch it
- Self-grade ON-COURSE without `flight-checker` PASS
- Claim a sweep without a RECEIPT
- Add features or hunt unrelated siblings

## Pairs with

- skills: `do-it-right`, `post-flight`, `root-cause-fix`, `debugging-an-issue`,
  `review-build`, `agentic-loop`
- rules: `deep-flight-rule`, `do-it-right-rule`, `no-shortcuts`,
  `definition-of-done`
- agents: `flight-checker`, `reviewer`
- commands: `deep-flight-cmd` (`/deep-flight`), `do-it-right-cmd`
  (`/do-it-right`), `post-flight-cmd` (`/post-flight`)
- refs: `_shared/flight-family.md`, `_shared/scripts/shortcut-sweep.sh`
