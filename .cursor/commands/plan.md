---
description: Produce a complete zero-shortcut Cursor Buildable plan (CreatePlan) plus research .md. Do not implement.
---

Everything after this command is the task. Run the `create-plan` skill in full.
Do not write implementation code in this session.

**Plan Mode required for CreatePlan delivery in Cursor.** If you are not in Plan
mode, switch first (`SwitchMode` → plan / Shift+Tab). CreatePlan is what shows
the **Build** button — writing only `docs/plans/*.md` is not enough.

## Ground rules

- Comprehensive means nothing left unresolved, not maximum length. No filler.
- Every claim about existing code must come from reading the file in this session. Cite the path (and line where it matters).
- No TBDs, no "decide later", no placeholder sections.
- If ambiguity would change the design, ask numbered clarifying questions and **stop until answered**. For minor ambiguity, proceed and log the assumption. Open questions must be empty when the plan is delivered — resolve or non-goal everything else.
- Prefer the simplest design that fully satisfies the requirements. Robust means handles failure well, not maximal scope.
- Follow `create-plan` + `no-shortcuts`: in-repo evidence first (list files read, trace data flow, check the package manifest), mandatory external research, EARS/ACs, mini-ADRs, executable tasks, and for nontrivial work a `task-topology` declaration (§8b + `.loadout/tasks/<slug>/TASK.md`).
- **Delivery (Cursor):** `CreatePlan` (name, overview, plan, non-empty todos)
  **and** research `docs/plans/YYYY-MM-DD-<slug>.md`. See
  `create-plan/references/cursor-native-plan.md`.

## If the task is missing

Ask one line: "What do you want planned?" Then stop until answered.

## After drafting

Prefer `/review-plan` (or "Review the plan") before clicking **Build** —
especially for non-trivial work. After review, refresh CreatePlan so Build
matches the approved plan. Skip planning when the change is a one-sentence
diff. For hard problems, run `/plan` across two models in parallel (worktrees)
and merge the best plan.

Task: $ARGUMENTS
