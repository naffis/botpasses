---
description: Dig deeper before fixing — re-diagnose, multi-issue hunt, ≥2 solutions, class-kill (no bandaids).
---

Run the `do-it-right` skill in full. The user approved a fix (or asked to do it
correctly). Do **not** implement the first proposal.

Treat the prior diagnosis as DRAFT. Re-diagnose with ≥3 hypotheses, hunt for
additional issues, score ≥2 real solutions, reject proximate/heuristic
bandaids, print Chosen Fix, then implement via `root-cause-fix` or
`debugging-an-issue` (or inline for product SoT fixes). Prove with a class-pinning
regression.

## Process (do not skip)

1. Frame — symptom, prior draft, trigger vs class.
2. Re-diagnose — `references/diagnosis-gate.md` (no production edits).
3. Solutions — `references/solution-gate.md`; Chosen Fix before edits.
4. Implement — owning skill / class-kill at correct layer.
5. Prove — regression + inverse + DoD.
6. Do-it-right report.

Do not commit/push/PR unless explicitly asked.

Issue / prior proposal: $ARGUMENTS
