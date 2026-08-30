# Deferral taxonomy — complete-the-build

Punted work is first-class. Completing it is the default. Re-logging it as
"follow-up" without a survivor criterion is a shortcut (`no-shortcuts.mdc`).

## What counts as a deferral / punt

Sweep all of the following into gap-matrix rows (`Kind: deferral` or the
matching phase/AC row marked `Punted`):

| Source           | Examples                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session language | "as a follow-up", "left for later", "known residual", "deferred", "you could later", "next step would be", "I'll…", "out of scope for this pass" (when it was in the plan) |
| Todos            | `TodoWrite` / task list items still `pending` or `in_progress` for this plan                                                                                               |
| Diff markers     | `TODO` / `FIXME` / `HACK` / `XXX` **introduced or left** in changed files                                                                                                  |
| Stubs            | `not implemented`, placeholder returns, empty handlers, test-only mocks on prod paths                                                                                      |
| Plan sections    | "Discovered Issues", "Future Improvements", "Open Questions" that block ACs                                                                                                |
| Parking lot      | `docs/refactor-parking-lot.md` entries added for this change that are actually in-scope behavior (not true refactor-class)                                                 |
| Partial phases   | Phase marked done in chat but ACs or files unfinished                                                                                                                      |

## Default disposition

| Finding                          | Action                                             |
| -------------------------------- | -------------------------------------------------- |
| In-scope behavior / AC / DoD gap | **Build it now** — matrix row → work queue         |
| Bug / correctness / security     | **Fix now** (P0/P1)                                |
| True refactor-class cleanup      | Parking lot with path + reason; not a silent skip  |
| Explicit plan non-goal           | `Out-of-scope` with Notes pointing at the non-goal |

## Survivor criteria (only escape hatch)

A row may remain open after the exhaustion pass **only if** one of these is
true and named in the Completion Report:

1. **Human decision required** — product or architecture choice the agent
   cannot make; question stated for the user.
2. **External blocker** — missing secret, env, vendor access, or credential
   the agent cannot obtain.
3. **User-cut this session** — user explicitly removed the item from scope
   after the matrix was shown.
4. **Logged refactor-class only** — true behavior-preserving cleanup parked in
   `docs/refactor-parking-lot.md` (or the project's issue tracker) with id/path
   — **not** missing product behavior.

If none apply, the row is built. "Noted for later" without a survivor row is
a failure of this skill.

## Re-deferral ban

A deferral found in the inventory defaults to **Done** in this pass.
Logging it again requires naming one of the four survivor criteria above
in the report. Copy-pasting "follow-up" into the plan is not a survivor.
