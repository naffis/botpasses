---
name: verifying-session-surfaces
description: >
  Exercise every user-visible surface, feature, and function created or updated
  in this session at the real layer (UI, API, CLI, MCP, job, flag, realtime)
  with pasted evidence, then root-cause-fix failures with a fail-on-revert test.
  Triggers on "test all the surfaces", "verify session surfaces", "prove this
  session works", "session surface test", "/verify-surfaces", or the full prompt
  "test all the surfaces, features, functionality created or updated in this
  session to ensure it works". Anti-triggers: "root cause fix" on a single
  already-framed bug (no session-surface inventory) → root-cause-fix; code wrap /
  sibling hunt → post-flight; plan-vs-diff → review-build; full-product dogfood →
  exercising-the-product; UX heuristics → reviewing-ui; mid-build layer check →
  deep-flight.
---

# Verifying session surfaces

Prove the session's new or changed **live surfaces** work, then fix what the
proof turns up. Tests and a clean diff are necessary, not sufficient. A green
unit test of a helper you wrote in the same pass is circular — the oracle is
the running product a user (or caller) would hit.

Anthropic verification loop + Cursor `verify-this`, scoped to **this
conversation**, then `root-cause-fix`. It is an `agentic-loop`: contract,
evidence over recall, maker ≠ checker, budget, edits unstaged.

## Trigger

The user (or you, after a build) wants:

> test all the surfaces, features, functionality created or updated in this
> session to ensure it works. root cause fix any issues that are found.

Prefer this over `post-flight` when the question is "does it actually work?"
Prefer `post-flight` when the question is "did we ship what was asked, without
shortcuts or missed siblings?" Large session: surfaces first, then
`/post-flight`.

## Neighbors

| Ask                                            | Use instead                                   |
| ---------------------------------------------- | --------------------------------------------- |
| Ask-vs-ship + sibling sweep + shortcuts        | `post-flight`                                 |
| Diff vs a written plan                         | `review-build`                                |
| Dogfood the whole product / compounding rubric | `exercising-the-product`                      |
| UX heuristics / first-time user                | `reviewing-ui`                                |
| One framed bug, no session inventory           | `root-cause-fix`                              |
| Mid-build "are we still on the right layer?"   | `deep-flight`                                 |
| One named claim (baseline vs treatment)        | same evidence rules; inventory can be one row |

## Contract (fill after inventory, before exercise)

- **End state:** every session surface **and** ask-implied function has a
  falsifiable claim with a live verdict; every BROKEN is class-killed or
  escalated.
- **Evidence:** inventory `RECEIPT` + per-claim command/screenshot/HTTP
  transcript (not "✅ works"). Redact secrets.
- **Constraints:** no interface bypass; no toast-as-proof; no prod URL; no
  bandaid; no commit/push unless asked (`git-safety`).
- **Budget:** 3 edit→verify cycles per finding. At the ceiling, STOP.

Empty dirty tree ≠ empty session. See
[references/session-scope.md](references/session-scope.md).

## Workflow

### 0. Reconstruct the session

Read [references/session-scope.md](references/session-scope.md). Quote the
asks. Number implied surfaces **and** file-less functions. List files this
chat actually edited. Dirty-only inventory after a commit is a miss.

### 1. Inventory (mechanical RECEIPT)

```bash
.cursor/skills/verifying-session-surfaces/scripts/session-inventory.sh
# committed mid-session / clean tree:
.cursor/skills/verifying-session-surfaces/scripts/session-inventory.sh --since origin/dev
# shared trunk — this chat's paths only:
.cursor/skills/verifying-session-surfaces/scripts/session-inventory.sh path/a path/b
```

Loadout checkout: `plugins/core-engineering/skills/verifying-session-surfaces/scripts/session-inventory.sh`.
Claude Code plugin: the skill folder's `scripts/session-inventory.sh`.

Quote `RECEIPT` through `END`. Collapse files → surfaces
([references/surface-matrix.md](references/surface-matrix.md)), then
**UNION** ask-implied functions. Zero files + implied work → pass `--since`
or explicit paths; do not CLEAN.

### 2. Claims

One falsifiable claim per surface (Cursor `verify-this` shape):

`When I <action> under <preconditions>, I observe <result>.`

Happy path always. Added validation → one fail-closed claim. Smallest
exercise that could **disprove** it — not a product-wide tour.

If this session changed **two composing layers** (UI that posts to a new
API, CLI that calls a new MCP tool), add **one composed-path claim**.
Isolated-layer WORKS rows do not close the join.

Updated surface + a baseline SHA: optionally one claim that treatment
differs from baseline in the predicted direction. New surfaces need no
baseline (absence → 404 / missing control).

### 3. Preflight — start what you need

If any claim needs a running app, **start** the project's documented
dev command (from `AGENTS.md` / README / `package.json`). Wait for the
health probe. One listener per port. Probe-only then `BLOCKED` without
a start attempt is a skip.

Record known dev-only noise once. Run **existing** tests for touched
packages so later reds are attributable.

Do not hit production. Do not fire billable / GPU / paid-partner work
without the user asking — use the cheapest local fixture, or `BLOCKED`
with the cost reason.

### 4. Exercise at the real layer

Read [references/exercise-playbook.md](references/exercise-playbook.md).
UI → markup then screenshot then click (`ui-evidence`); API → real HTTP;
CLI → transcript; MCP → actual tool call; job/flag/realtime → the trigger
that would fire locally.

Verdict: `WORKS` | `BROKEN` | `BLOCKED` | `N/A`. `BLOCKED` is a finding.
Same-session tests still run — they are not the oracle. Independent
claims may run in parallel; composed paths stay serial.

### 5. Root-cause-fix every BROKEN

`root-cause-fix` (Loop A → class-kill → fail-on-revert test). Re-exercise
the **same** claim. Stale isolate after a code fix → restart the owning
process, then re-hit. Fix does not kill the repro → return to Loop A.

P0 (user-blocked / wrong-org leak / data loss) before P1 (degraded).
`BLOCKED` (env) is not a code fix — start the stack or escalate.

### 6. Independent checker

`flight-checker` (readonly, fresh, no `resume`) with the report +
`RECEIPT` + session paths. FAIL → one fix+recheck. Same-session self-grade
cannot be CLEAN. Routing: `_shared/flight-family.md`.

### 7. Report

[references/report.md](references/report.md). A `WORKS` row without a
quoted command, status, or screenshot is FAIL. CLEAN is illegal on an
empty RECEIPT unless reconstruction shows no session work.

## Suggested Checks

```bash
git status --porcelain
git diff --stat
git diff --stat --staged
.cursor/skills/verifying-session-surfaces/scripts/session-inventory.sh
# if that RECEIPT is empty after you know you shipped work:
.cursor/skills/verifying-session-surfaces/scripts/session-inventory.sh --since origin/dev
```

## Guardrails

- Never CLEAN from an empty dirty tree without reconstruction.
- Never bypass the surface to plant the state you were asked to reach.
- Never trust the app's own success toast.
- Never paste tokens, cookies, or PII in evidence — redact.
- Never exercise production or unbounded paid work unasked.
- Never turn this into `exercising-the-product` or `post-flight`.
- Leave edits unstaged.

## Pairs with

- skills: `root-cause-fix`, `agentic-loop`, `post-flight`, `deep-flight`,
  `review-build`, `reviewing-and-shipping`, `exercising-the-product`,
  `reviewing-ui`, `writing-tests`
- rules: `no-shortcuts`, `definition-of-done`, `regression-test`,
  `git-safety`, `ui-evidence`
- agents: `flight-checker`, `reviewer`
- commands: `verifying-session-surfaces-cmd` (`/verify-surfaces`)
- workflows: `ship-a-feature`, `plan-then-build`, `run-autonomous-loop`
- references: `session-scope.md`, `surface-matrix.md`, `exercise-playbook.md`,
  `report.md`
