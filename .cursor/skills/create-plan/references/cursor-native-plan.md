# Cursor-native plan delivery (CreatePlan)

## Why this exists

Cursor's **Build** button is wired to the **`CreatePlan`** tool result in Plan
mode. It writes `~/.cursor/plans/<slug>_<hash>.plan.md` and opens the interactive
plan UI.

Writing a normal file with the **`Write`** tool (`docs/plans/…` or workspace
`.cursor/plans/…`) is **documentation only**. It does **not** create a Buildable
plan. Stopping there is a skill failure when the user expects Build.

## Two artifacts

| Artifact                                | Tool         | Path                                                              | Purpose                      |
| --------------------------------------- | ------------ | ----------------------------------------------------------------- | ---------------------------- |
| **Primary (required)**                  | `CreatePlan` | `~/.cursor/plans/*.plan.md`                                       | UI + **Build**               |
| **Research (required for non-trivial)** | `Write`      | `docs/plans/YYYY-MM-DD-<slug>.md` (or workspace `.cursor/plans/`) | Full template; git-shareable |

Link the research path from the CreatePlan body. Never claim "plan written" from
Write alone.

## Mode gate

1. If **already in Plan mode** → research, then call `CreatePlan`.
2. If **Agent / Ask / Debug** → switch to Plan (`SwitchMode` → `plan` /
   Shift+Tab). After accepted, call `CreatePlan`.
3. If `CreatePlan` is missing → tell the user to toggle Plan and re-run. Do not
   silently degrade to Write-only.

`create-plan` / `run create-plan` / `/plan` buried in a long prompt still
requires this delivery.

## CreatePlan call shape

```json
{
  "name": "Short Title",
  "overview": "One sentence outcome + approach.",
  "plan": "# Title\n\nFull markdown body (no YAML frontmatter here)…",
  "todos": [{ "id": "t01-…", "content": "T-01 title — acceptance one-liner" }]
}
```

Rules: `todos` non-empty (one per `T-0N`); do not implement until Build or an
explicit implement ask. For nontrivial plans, include the **Task topology** block
(create-plan §8b) in the CreatePlan `plan` body and link
`.loadout/tasks/<slug>/TASK.md`.
