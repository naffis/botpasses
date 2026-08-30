---
description: Exercise this session's new/changed live surfaces and root-cause-fix what breaks.
---

Run the `verifying-session-surfaces` skill in full. The question is "does
what we just built actually work?" — not ask-vs-ship (`post-flight`) and
not plan-vs-diff (`review-build`).

## Process (do not skip)

0. Reconstruct — verbatim asks, implied file-less functions, files this
   chat edited (`references/session-scope.md`). Dirty-only after a commit
   is a miss.
1. Inventory — `session-inventory.sh` (quote RECEIPT). Empty → `--since`
   <trunk> or explicit paths; never CLEAN. Collapse files → surfaces,
   UNION ask rows, add a composed-path row when two layers join.
2. Claims — one falsifiable "When I … I observe …" per row.
3. Preflight — **start** the stack if a claim needs it; local/dev only;
   no unasked paid/GPU runs.
4. Exercise at the real layer (`references/exercise-playbook.md`).
   Paste evidence (redact secrets). Verdict per row.
5. Every BROKEN → `root-cause-fix`. Re-exercise the same claim (restart
   stale isolates first).
6. Isolated `flight-checker` (readonly, no resume) on the report +
   RECEIPT. FAIL → one fix+recheck.
7. Report (`references/report.md`). CLEAN requires evidence on every
   WORKS row and a reconstructed session.

Do not commit/push/PR unless explicitly asked. Prefer `/post-flight`
after this when you also want sibling-code + shortcut sweeps.

Scope / notes: $ARGUMENTS
