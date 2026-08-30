# Gap matrix — complete-the-build

Build this matrix **before any implementation edits**. Rebuild it from the
plan + git evidence on every completeness re-pass — do not copy statuses from
memory.

## Template

```markdown
| #   | Plan item                     | Kind  | Status  | Location       | Verified how               | Notes              |
| --- | ----------------------------- | ----- | ------- | -------------- | -------------------------- | ------------------ |
| 1   | Phase 2 — bind seed fanout    | phase | Partial | `path:symbol`  | test name / command / read | missing error path |
| 2   | WHEN bind fails, surface card | AC    | Missing | —              | —                          |                    |
| 3   | surface registration (API/docs) | DoD | Done  | routes + docs  | gate / checklist           |                    |
```

**Kind:** `phase` | `task` | `AC` | `DoD` | `discovered` | `deferral`

**Status:**

| Status         | Meaning                                         |
| -------------- | ----------------------------------------------- |
| `Done`         | Implemented + verified (file:symbol + how)      |
| `Partial`      | Started; acceptance not fully met               |
| `Missing`      | Not implemented                                 |
| `Punted`       | Explicitly deferred / stubbed / "follow-up"     |
| `Out-of-scope` | Non-goal or user-cut; **requires Notes reason** |

Open work for the build loop = `Partial` + `Missing` + `Punted`.
`Out-of-scope` does not enter the queue.

## Row sources (enumerate all)

1. **Plan phases** — every phase heading / numbered phase in the plan.
2. **Plan tasks** — every executable task under those phases (files, deps, AC).
3. **Acceptance criteria** — every Given/When/Then or EARS SHALL in the plan.
4. **Definition of Done** — every applicable row in `definition-of-done` /
   `rules/definition-of-done.mdc` for this change class (source, tests, docs,
   migrations, flags, …).
5. **Discovered Issues** — in-scope P0/P1 items logged on the plan during build.
6. **Deferral inventory** — see `deferral-taxonomy.md` (session language,
   TODOs in the diff, unfinished todos, parking-lot entries for this work).

If there is no written plan, build rows from the **original user request** and
any acceptance criteria stated in-session — then prefer writing/updating a
plan artifact before a large exhaustion pass.

## Evidence rules

- **Location** must be a real path (and symbol when useful). `—` only for
  Missing / Out-of-scope.
- **Verified how** is a test name, pasted command outcome, or explicit file
  read — never "looks good" or "from memory".
- Inverse check: anything shipped that is **not** a matrix row is either
  justified in Notes (one line) or reverted as scope creep.

## Empty-matrix rule

If the first inventory shows zero open rows, do not invent work. Report
COMPLETE (or COMPLETE WITH SURVIVORS if any Out-of-scope / survivor rows)
and hand off to `review-build`.
