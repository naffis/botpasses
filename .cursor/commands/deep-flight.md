---
description: Mid-session in-flight quality gate — chosen layer, shortcut RECEIPT, gates, flight-checker.
---

Run the `deep-flight` skill in full. You are mid-build. Prove the work is still
on the class-kill path and **fix drift now**. This is not `deep-dive` and not
`post-flight`.

## Process (do not skip)

1. Frame — verbatim ask, Chosen layer (file:symbol), git status/diff stat.
2. Layer check — owning invariant still holds; bandaids are P0.
3. Shortcut sweep — `_shared/scripts/shortcut-sweep.sh` (quote RECEIPT).
4. Gates — project verify commands; paste closers.
5. Isolated `flight-checker` (readonly, no resume). FAIL → one fix+recheck.
6. Deep-flight report (ON-COURSE / CORRECTED / OFF-COURSE).

If no Chosen Fix exists yet, stop and run `do-it-right`. If the session is
wrapping, hand off to `post-flight` after ON-COURSE.

Do not commit/push/PR unless explicitly asked.

Scope / notes: $ARGUMENTS
