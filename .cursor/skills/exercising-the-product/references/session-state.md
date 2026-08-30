# Session state: the spine of a repeated quality loop

The loop's memory lives on disk, not in the conversation. A fresh context must be able
to read one file and resume exactly where the last session stopped — without re-running
finished scenarios, re-fixing closed issues, or re-discovering known problems.

Default location: `_local/quality-loop-STATE.md` (gitignored scratch), or wherever the
project already keeps loop state. One file per loop, appended across sessions.

## Template

```markdown
# Quality loop state — <product>

## Contract
- End state: <N scenarios + mutation matrix + fixes, gates green>
- Budget: <scenarios/session, edit-verify cycles/fix, stall timeout>
- Constraints / never do: <forbidden ops: real publishes, prod writes, ...>

## Evidence map (fill once, copy-paste commands)
- events/trace: <SQL / CLI>
- domain records: <SQL / CLI>
- logs: <where; note what's authoritative vs trimmed>
- rendered output: <curl / fetch command>
- debug endpoints: <URLs>
- known dev-only noise to ignore: <list>

## Scenario rotation
1. <type A> — run YYYY-MM-DD (session 3)
2. <type B> — run YYYY-MM-DD (session 4)
3. <type C> — NEXT
...vary; never repeat the last run's type.

## Current session
- Status: <phase, scenario ids, timestamps>
- Coordination: <files another session owns — do not touch>

## Mutation matrix (per scenario)
| Operation | Result | Evidence |
| --- | --- | --- |
| NL edit | ✓ | output re-fetched, change present, no build failure |
| stale-version conflict | ✗ → QL-C-2 | accepted silently, should 409 |
| ... | | |

## Issues ledger (append-only)
| ID | Sev | Surface | Symptom | Evidence | Root cause | Fix | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| QL-A-1 | HIGH | engine | run ends mid-promise | output tokens hit the cap | truncation treated as a normal stop | continuation handling at the model-call layer + test | FIXED |
| QL-C-2 | HIGH | api | stale edit accepted | ... | ... | ... | OPEN |

## Known-fixed classes (re-verify at most; do NOT re-fix)
- <one line per class, with the fix location>

## Known-open issues (do NOT re-discover)
- <ID + one line + what decision it's waiting on>

## Closing summaries (one per session)
- Session 4 (YYYY-MM-DD): ran <B>; found QL-B-1..3; fixed 2; left QL-B-3 (needs product decision).
```

## Rules of use

- **Ledger is append-only.** Status changes edit the `Status` cell; history stays.
- **IDs are stable**: `QL-<scenario letter>-<n>`, keyed to the scenario that surfaced the
  issue, so evidence stays traceable across sessions.
- **Every claim carries evidence** — a query, a file path, a screenshot name. "Seemed
  broken" is not a ledger entry.
- **Write as you go**, not at the end. A session that dies mid-run should still leave a
  resumable file.
- **Parallel sessions:** before editing any file, check `git status` and the
  Coordination section; add your own claims there while you hold files.
