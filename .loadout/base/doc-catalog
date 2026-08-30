# loadout catalog

Every asset, what it's for, and how to invoke it. Hand-maintained; run `loadout list` for
the live index and `loadout list --installed` for what's in a project. See
[`usage.md`](./usage.md) for how each type loads.

**Calling, in short:** skills → auto-trigger on a matching request, or `/skill-name` (Claude
Code); rules → load by their mode (see each below); subagents → "use the `<name>` subagent";
command → `/changelog`.

---

## Skills (55)

### Getting started (start here)

| Skill             | What / when                                                                                                                                                                 | Call                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `getting-started` | Route a goal to the right workflow + supporting skills/rules, decide manual vs loop, and emit a ready-to-run kickoff prompt.                                                | "I want to build X, what should I do?" / new to a repo           |
| `deep-dive`       | Take a brief seed (idea / feature / bug / problem), investigate repo then world, force real alternatives, one self-critique, land on the best solution. Does not implement. | `deep dive:` / `dig in:` followed by the seed                    |
| `deep-flight`     | Mid-session in-flight quality gate: chosen layer, shortcut RECEIPT, quoted gates, readonly `flight-checker`. Fixes drift now. Not `deep-dive`.                              | `deep-flight` / `/deep-flight` / "are we still doing this right" |

### Agentic loops & orchestration

| Skill                           | What / when                                                                                                                                                                                                | Call                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `agentic-loop`                  | Run a non-trivial task as a verifiable perceive→plan→act→observe→verify→reflect loop: stop-condition contract, ground-truth verification, maker≠checker, durable memory, context budget, bounded autonomy. | long-horizon/multi-step work; "run this as a loop"            |
| `running-a-dev-cycle`           | Adaptive end-to-end cycle: classify a task (QUICK/ENHANCEMENT/INTEGRATION/INVESTIGATION/ITERATION) and route it through the lightest path, each phase an agentic loop.                                     | "build this end to end" / "autonomous mode"                   |
| `orchestrating-parallel-agents` | Run N independent items in parallel — worktrees by default, or shared trunk when `shared-working-tree` is installed; bounded concurrency; serialized landing gated by maker-checker.                       | "do these in parallel" / "clear the queue"                    |
| `task-topology`                 | Triage a nontrivial task into single-loop / pipeline / graph; write the TASK.md contract (units, allowlists, verifiers, merge order). Default single-loop; graph only when both escalation tests pass.     | start of nontrivial work / "single loop vs graph"             |
| `decompose`                     | Size pipeline/graph units (one session each), write the shared contract file, per-unit verifiers and done-conditions. Interfaces before implementation.                                                    | after task-topology chooses pipeline/graph                    |
| `integrate`                     | Fan-in units in merge order; full-suite verifier after each merge; re-dispatch contract violators; spec review for divergent interface interpretations.                                                    | units report done / "merge the graph"                         |
| `agent-tool-design`             | Design a product's agent-facing tools/MCP well (ACI): fewer higher-signal tools, namespacing, high-signal results, token efficiency, steering descriptions/errors.                                         | authoring/editing a tool schema, description, or result shape |

### Product quality loops (dogfood, review, iterate)

| Skill                    | What / when                                                                                                                                                                                                                                       | Call                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `exercising-the-product` | Dogfood the product end to end: drive real scenarios through the running app, judge every artifact against a compounding rubric, exercise every mutation tool, root-cause-fix defects with fail-on-revert tests, leave a ledger for the next run. | "exercise the product" / "run the quality loop" / "dogfood the app" |
| `reviewing-ui`           | Multi-cycle dual-lens UI/UX review-and-fix loop: context brief → screen inventory → cold walkthrough → heuristic audit → P0–P3 findings in `UI-REVIEW.md` → small fix batches → re-verify through the rendered UI.                                | "review the UI" / "usability audit" / resume `UI-REVIEW.md`         |
| `recreating-a-design`    | Recreate an image/mockup/live site as responsive HTML/CSS (or match an existing implementation to a target) via a render→measure→look-at-the-diff→fix loop with keep-best and converge/budget/plateau stops.                                      | "recreate this" / "pixel perfect" / "match this mockup"             |

### Shipping & pull requests

| Skill                         | What / when                                                                                                                                                                                                   | Call                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `create-plan`                 | Zero-shortcut plan: CreatePlan + research `.md` + `plan-ban-sweep` + `plan-checker`. Clarify first. Never Write-only in Cursor.                                                                               | "create-plan" / `/plan`                                                 |
| `review-plan`                 | Multi-pass plan stress-test; Pass 5 = `plan-ban-sweep` RECEIPT + `plan-checker` (not "think harder"). Fix in place; refresh CreatePlan.                                                                       | "Review the plan" / `/review-plan`                                      |
| `complete-the-build`          | Exhaust Partial/Missing/Punted: gap matrix before coding, `shortcut-sweep` RECEIPT, two clean passes, hand off to `review-build`.                                                                             | "Complete the build" / `/complete-the-build`                            |
| `session-handoff`             | Write or resume a durable handoff so a fresh chat continues without cold-start archaeology.                                                                                                                   | "write a handoff" / `/session-handoff`                                  |
| `review-build`                | Evidence-first implementation review: git diff, plan trace, `shortcut-sweep` RECEIPT, pasted gates, `flight-checker`. Prefer fresh chat.                                                                      | "Review the build" / `/review-build`                                    |
| `post-flight`                 | End-of-session review-and-FIX: ask vs ship, scripted shortcut sweep, class-kill, sibling sweep, DoD, gates, `flight-checker`. Completes deferred work by default.                                             | "post-flight" / "run post-flight" / `/post-flight`                      |
| `verifying-session-surfaces`  | Exercise every session-created/updated live surface (UI/API/CLI/MCP/job) with pasted evidence, then root-cause-fix failures. Complementary to `post-flight` (code wrap) and Cursor `verify-this` (one claim). | "test all the surfaces" / "ensure it works" / `/verify-surfaces`        |
| `planning-a-change`           | Explore → plan → implement a non-trivial change. Before multi-file/unfamiliar work; skip one-liners. Plan-only → `create-plan`.                                                                               | `/planning-a-change` or describe a multi-file task                      |
| `reviewing-and-shipping`      | Review for correctness & intent, run tests, wrap up; commit/PR only when asked (whole-tree commit if shared-working-tree).                                                                                    | when wrapping up a change                                               |
| `writing-commit-messages`     | Conventional-commit message from a diff.                                                                                                                                                                      | when committing / "write a commit message"                              |
| `committing-on-shared-trunk`  | Commit/push the entire shared trunk working tree — no stash, no session-scoped staging, no branch unless asked.                                                                                               | "commit" / "commit and push" with parallel agents / shared-working-tree |
| `opening-a-pr`                | Branch → push → PR with a validation-first description. Only when user explicitly asks for a PR.                                                                                                              | when turning work into a PR                                             |
| `making-a-pr-reviewable`      | Tidy history, sharpen description, add reviewer guidance (no behavior change).                                                                                                                                | before review on a noisy/large PR                                       |
| `rebasing-a-branch`           | Rebase onto base with semantic conflict review and `--force-with-lease`.                                                                                                                                      | when a branch is behind                                                 |
| `triaging-review-feedback`    | Bucket unresolved PR comments into a plan and address them.                                                                                                                                                   | when a PR has open threads                                              |
| `assessing-release-readiness` | Go / no-go assessment (gates, risk, rollback).                                                                                                                                                                | before promoting / releasing                                            |

### Debugging & CI

| Skill                          | What / when                                                                                                                                                                        | Call                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `debugging-an-issue`           | Evidence-first root-cause loop (read error, expected vs actual, repro, falsify, fix, regression test) + a per-symptom decision tree.                                               | a non-obvious bug/failure                                     |
| `do-it-right`                  | Dig-deeper gateway after "yes / do it correctly": re-diagnose, multi-issue hunt, ≥2 solutions, reject bandaids, class-kill, RECEIPT + `flight-checker`. Mid-build → `deep-flight`. | "do it correctly" / `/do-it-right`                            |
| `root-cause-fix`               | Prove the one true cause (Loop A) → converge a no-bandaid class fix (Loop B) → implement at the root → regression-lock → independent checker.                                      | "find the root cause and fix it properly" / "analyze and fix" |
| `debugging-with-observability` | Debug a production/staging issue from runtime evidence (correlation ids → query logs/traces → interpret → tail → hand off).                                                        | "why did it fail in prod?" / no local repro                   |
| `fixing-ci`                    | Find failing checks, classify (env/flake/real), fix the root cause.                                                                                                                | red PR checks / failing build                                 |
| `triaging-flaky-tests`         | Diagnose non-determinism with evidence; real fix, not retries.                                                                                                                     | a test that passes/fails randomly                             |

### Testing

| Skill                     | What / when                                                                                              | Call                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `writing-tests`           | Effective tests for new/changed code — behavior, edge & error paths, right level, boundary-only doubles. | adding a feature / working test-first / filling a gap |
| `test-driven`             | Strict red→green→refactor; no production code before pasted RED.                                         | "TDD" / `/tdd`                                        |
| `improving-test-coverage` | Raise coverage meaningfully (branches & critical paths), set a diff-coverage gate, no gaming.            | low/unmeasured coverage, hardening a module, CI setup |

### Code quality & refactoring

| Skill                    | What / when                                                                                                  | Call                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `reviewing-code-quality` | Maintainability audit: oversized files/functions, nesting, duplication, leaky boundaries, dead code, naming. | assess code health / before a big merge |
| `refactoring-code`       | Behavior-preserving refactor behind a test net, in small reviewable moves.                                   | improving structure of existing code    |
| `simplifying-code`       | Behavior-preserving clarity/YAGNI pass on the diff (distinct from `deslopping`).                             | "simplify" / `/simplify`                |
| `deslopping`             | Remove AI-generated slop from a branch diff (no behavior change).                                            | after generating code, before review    |

### Dependencies & data

| Skill                      | What / when                                                                                                                                                | Call                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `reviewing-dependencies`   | Audit outdated deps; review version-bump PRs for breaking changes.                                                                                         | dependency reports / bump PRs                           |
| `researching-a-dependency` | Research an unfamiliar API/library/service from primary sources and distill it into a versioned, cited, implementation-ready reference before integrating. | before adopting new tech / "research X before we build" |
| `writing-a-migration`      | Safe, reversible, expand/contract DB migration.                                                                                                            | schema change or backfill                               |

### Documentation (keep docs current with code)

| Skill                    | What / when                                                                                                        | Call                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `updating-docs`          | Find & update every doc surface a change touches (README, API, docstrings, config, changelog), in the same change. | whenever a change alters behavior/API/config/process |
| `writing-an-adr`         | Record a significant decision as a short ADR (context/decision/consequences/alternatives).                         | a significant or hard-to-reverse choice              |
| `auditing-doc-freshness` | Sweep for drift — dead links, renamed symbols, stale commands/examples — and fix/flag.                             | before a release, after a refactor, periodically     |

### Reporting

| Skill                 | What / when                                                          | Call                            |
| --------------------- | -------------------------------------------------------------------- | ------------------------------- |
| `summarizing-my-work` | Ad-hoc status note from authored commits over any window.            | "what did I get done" / standup |
| `weekly-review`       | Structured weekly synthesis (net-new / bugfix / tech-debt + themes). | weekly recap / retro            |

### Meta — keep loadout itself sharp (plugin: `meta`)

| Skill                   | What / when                                                                                   | Call                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `hardening-the-harness` | "The ratchet": turn a real failure into a permanent guard in the right layer.                 | after a mistake you don't want again                            |
| `equipping-loadout`     | Follow `INSTALL.md` to install (starter = ship-a-feature kit) or update loadout in a project. | "use this" / "update loadout" / paste github.com/naffis/loadout |
| `skill-author`          | Scaffold a SKILL.md to conventions; apply the rule-vs-skill test.                             | creating/restructuring a skill                                  |
| `rule-author`           | Scaffold a `.mdc` rule with the right type/frontmatter.                                       | creating/restructuring a rule                                   |
| `learning-from-chats`   | Mine recurring preferences from chats → rules/skills/AGENTS.md.                               | "learn how I work" / capture a correction                       |

---

## Rules (37)

How a rule loads is set by its frontmatter. You don't usually call rules; they load
automatically (or `@rule-name` for manual ones).

### Always on (kept short — load every request)

| Rule                  | Gist                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `no-shortcuts`        | No stubs/bandaids/silent fallbacks; don't claim green without pasted output; read before asserting; ask on ambiguity. |
| `size-limits`         | Files ~<400 (hard ~1000), functions ~<50; extract before sprawl.                                                      |
| `regression-test`     | Every bug fix ships a test that fails before and passes after.                                                        |
| `no-inline-imports`   | Imports at module top; no inline/lazy imports.                                                                        |
| `no-secrets-in-code`  | Never hardcode secrets/PII; env/secret store; never log them.                                                         |
| `git-safety`          | No autonomous commit/branch/push/PR/stash/WIP wipe; explicit ask required.                                            |
| `no-stash`            | Absolute ban on `git stash` (and stash-like /tmp moves).                                                              |
| `shared-working-tree` | Parallel agents share one local trunk; no per-agent branches/worktrees; commit-all via skill.                         |

### Auto-attached by file glob

| Rule                           | Globs           | Gist                                                                              |
| ------------------------------ | --------------- | --------------------------------------------------------------------------------- |
| `no-any`                       | `**/*.ts(x)`    | Ban `any`/`@ts-ignore`; `unknown` + narrowing.                                    |
| `no-floating-promises`         | `**/*.ts(x)`    | Await/return/void+catch; use platform "wait until".                               |
| `typescript-exhaustive-switch` | `**/*.ts(x)`    | `never` default case on unions/enums.                                             |
| `testing-conventions`          | test/spec globs | Arrange-Act-Assert; mock only at boundaries.                                      |
| `copy-voice`                   | `**/*.md(x)`    | Human, direct copy; no em-dashes, no filler/hype.                                 |
| `db-migration-safety`          | migration globs | Reversible, expand/contract; never reset a remote DB.                             |
| `docstrings-current`           | code globs      | In-code docs/docstrings reflect current behavior; comments explain why, not what. |

### Agent-requested (pulled in when relevant)

| Rule                            | Gist                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `refactor-discipline`           | Behavior-preserving, scoped; test net first; no bundled fixes.                                                                                                                        |
| `test-coverage`                 | Coverage is a guide not a goal; cover new code + branches/error paths; pick a floor, don't game it.                                                                                   |
| `observability-first`           | Read logs/traces before source; structured logging + correlation IDs.                                                                                                                 |
| `documentation-updates`         | Update the matching doc/changelog/ADR in the same change.                                                                                                                             |
| `commit-and-pr-conventions`     | Conventional commits; validation-first PR descriptions; whole-tree commit when shared-working-tree is on.                                                                             |
| `prompt-extraction`             | Long prompts live in dedicated modules, not inline.                                                                                                                                   |
| `audit-external-skills`         | Treat third-party skills/rules/MCP as untrusted; review first.                                                                                                                        |
| `lockfile-conflicts`            | Never hand-merge lockfiles; resolve the manifest, regenerate.                                                                                                                         |
| `dependency-version-management` | Detect/respect the version manager; don't switch runtimes unasked.                                                                                                                    |
| `agentic-loop-rule`             | The verified-loop non-negotiables (stop contract, ground-truth verify, maker≠checker, durable memory, context budget, bounded autonomy); loads the `agentic-loop` skill.              |
| `definition-of-done`            | A change is done only when behavior + tests + docs + surface registration land in the SAME change, gate green, edits left for review.                                                 |
| `create-plan`                   | Zero-shortcut planning non-negotiables (CreatePlan + research .md in Cursor; no TBD/stubs); loads the `create-plan` skill. Registry id: `create-plan-rule`.                           |
| `deep-dive`                     | Seed-to-recommendation non-negotiables (classify, repo-first, forcing functions, one self-critique pass); loads the `deep-dive` skill. Registry id: `deep-dive-rule`.                 |
| `deep-flight`                   | Mid-session in-flight non-negotiables (chosen layer, RECEIPT, gates, `flight-checker`); loads the `deep-flight` skill. Registry id: `deep-flight-rule`.                               |
| `review-plan`                   | Multi-pass plan review non-negotiables (fresh research, pre-mortem, fix in place, final sweep); loads the `review-plan` skill. Registry id: `review-plan-rule`.                       |
| `complete-the-build`            | Gap-exhaustion non-negotiables (matrix before coding, no silent deferrals, two clean passes); loads the `complete-the-build` skill. Registry id: `complete-the-build-rule`.           |
| `do-it-right`                   | Dig-deeper non-negotiables after "yes/do it correctly"; loads the `do-it-right` skill. Registry id: `do-it-right-rule`.                                                               |
| `review-build`                  | Evidence-first build review non-negotiables (diff as ground truth, plan trace, shortcut sweep, pasted gate output); loads the `review-build` skill. Registry id: `review-build-rule`. |
| `no-regex-for-semantics`        | Regex is structural, LLMs are semantic; don't keyword-match meaning — emit a structured field or call a model.                                                                        |
| `capability-removal`            | Removing a capability means removing all of it — wiring, tests, docs, config, dead code — not just the entry point.                                                                   |
| `ui-evidence`                   | UI claims require UI evidence: render and look, never bypass the interface to make a check pass, re-verify after every mutation, check multiple widths, show the artifacts.           |
| `implement-node`                | Per-unit executor for task graphs: allowlist-only edits, contract read-only, own verifier, PASSED/FAILED only (no caveats). Registry id: `implement-node-rule`.                       |

---

## Subagents (7)

Dispatch with "use the `<name>` subagent". They run in a fresh context and report back.

| Agent               | Role                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `reviewer`          | Independent diff review vs stated intent — report gaps, not style.                                                |
| `flight-checker`    | Readonly verifier for do-it-right / deep-flight / post-flight / verifying-session-surfaces / review-build claims. |
| `plan-checker`      | Readonly verifier for create-plan / review-plan artifacts (CreatePlan dual-write).                                |
| `security-reviewer` | Injection / authz / secrets / unsafe data handling (strong model, high effort).                                   |
| `explorer`          | Read-only codebase investigation; returns a tight findings report.                                                |
| `ci-watcher`        | Monitor the PR's CI; concise pass/fail with links to failures.                                                    |
| `implement-node`    | Execute one TASK.md unit under hard allowlist + unit verifier; report PASSED/FAILED.                              |

## Commands (15)

| Command               | What                                                                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`              | Shortcut entry point: tell it your goal, get a recommendation + a ready-to-run kickoff prompt (runs `getting-started`).                                              |
| `/build-as-graph`     | Triage one task into single-loop / pipeline / graph and run the verified unit workflow (registry id: `build-as-graph-cmd`).                                          |
| `/plan <task>`        | Produce a complete zero-shortcut Cursor Buildable plan + research .md (runs `create-plan`). Prefer Plan Mode.                                                        |
| `/review-plan`        | Stress-test a plan: PASS/FAIL checklist, fresh research, fix the plan in place (runs `review-plan`). Prefer a fresh chat.                                            |
| `/complete-the-build` | Exhaust remaining plan phases: gap matrix → build Partial/Missing/Punted to empty → hand off to `review-build`.                                                      |
| `/do-it-right`        | Dig deeper before fixing: re-diagnose, multi-issue hunt, ≥2 solutions, class-kill (runs `do-it-right`).                                                              |
| `/deep-flight`        | Mid-session in-flight gate: chosen layer, RECEIPT, gates, `flight-checker` (runs `deep-flight`).                                                                     |
| `/review-build`       | Evidence-first review of implemented work vs plan/request (runs `review-build`). Prefer a fresh chat.                                                                |
| `/post-flight`        | End-of-session review-and-FIX: ask vs ship, class-kill, sibling sweep, independent checker (runs `post-flight`).                                                     |
| `/verify-surfaces`    | Exercise this session's new/changed live surfaces and root-cause-fix what breaks (runs `verifying-session-surfaces`; registry id: `verifying-session-surfaces-cmd`). |
| `/session-handoff`    | Write or resume a durable session handoff for a fresh chat (runs `session-handoff`).                                                                                 |
| `/tdd`                | Strict red→green→refactor; no production code before pasted RED (runs `test-driven`).                                                                                |
| `/simplify`           | Behavior-preserving clarity/YAGNI pass on the current diff (runs `simplifying-code`).                                                                                |
| `/quality-loop`       | Run one cycle of the product quality loop (routes to `exercising-the-product` / `reviewing-ui` / `recreating-a-design`; optional focus area argument).               |
| `/changelog`          | Draft release notes from merged work since the last tag.                                                                                                             |

---

## Workflows (14)

Named recipes (`processes/workflows/`). Each lists the rules/skills/commands/agents it
composes and optional `gate` / `stop_condition` / `state`.

| Workflow              | Composes                                                                                                                                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ship-a-feature`      | rules + `planning-a-change` → implement → `verifying-session-surfaces` (live surfaces) → `deep-flight` (substantial edits) → `review-build` → optional `post-flight` → `reviewer` → `writing-commit-messages` / `opening-a-pr` / `making-a-pr-reviewable`; gate = tests+lint |
| `build-as-graph`      | `task-topology` → (`decompose` → `implement-node` ×N → `integrate`) or single-loop handoff; full-suite after each merge; `/review-build` allowlist check; honors `shared-working-tree`                                                                                       |
| `plan-then-build`     | `/plan` → `/review-plan` → implement → `/verify-surfaces` → `/deep-flight` → `/complete-the-build` (when open rows) → test → docs → `/review-build` → optional `/post-flight` → `reviewer` → PR; high-rigor alternative to `ship-a-feature`                                  |
| `fix-ci-until-green`  | `ci-watcher` → `fixing-ci` / `triaging-flaky-tests` / `debugging-an-issue`; stop = checks green                                                                                                                                                                              |
| `debug-production`    | `debugging-with-observability` → repro → `do-it-right` (when shallow yes-fix) / `debugging-an-issue` / `root-cause-fix` → `deep-flight` after non-trivial implement → regression lock → `reviewer`; hand off to `hotfix-and-rollback` when needed                            |
| `security-pass`       | `security-reviewer` → root-cause fixes → re-check → `reviewer`; stop = no remaining exploitable P0/P1                                                                                                                                                                        |
| `clear-the-queue`     | `orchestrating-parallel-agents` + worktrees **or** shared trunk; waves ≤3; serial maker≠checker landing                                                                                                                                                                      |
| `safe-refactor`       | `reviewing-code-quality` → test net → `refactoring-code` (green→green) → `reviewer` (behavior unchanged)                                                                                                                                                                     |
| `ship-a-migration`    | expand/contract via `writing-a-migration` → up/down tests → readiness → `multi-plane-deploy`                                                                                                                                                                                 |
| `dependency-bump`     | `reviewing-dependencies` → changelog research → regenerate lockfile → `fixing-ci` → `reviewer`                                                                                                                                                                               |
| `cut-a-release`       | `assessing-release-readiness` → `/changelog` → `multi-plane-deploy`; gate = readiness GO                                                                                                                                                                                     |
| `onboard-to-codebase` | `explorer` + `planning-a-change`                                                                                                                                                                                                                                             |
| `run-autonomous-loop` | `running-a-dev-cycle` + `agentic-loop` + plan (`/plan`/`review-plan` when needed) + `review-build` + `root-cause-fix` → `reviewer` → `reviewing-and-shipping`; stop = contract met + review-build PASS + reviewer SAFE + gate green                                          |
| `run-quality-loop`    | `exercising-the-product` / `reviewing-ui` + `agentic-loop` + `root-cause-fix` → `reviewer`; stop = clean pass with zero new high-severity findings + gate green                                                                                                              |

---

## Runbooks (6) — `processes/runbooks/`

| Runbook               | What                                                                                                                 |
| --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `bootstrap-project`   | First-day equip: `loadout init` → baselines → starter rules/workflow → doctor → `/start`; what not to binge-install. |
| `harness-setup`       | Default → self-improving progression; the ratchet; work backwards from behaviour.                                    |
| `harness-hooks`       | The enforcement layer: ready-to-paste `hooks.json` + scripts (format, checks, block-destructive, approval).          |
| `loop-preflight`      | Gates before automating a loop (4-condition test, 30-second check, Ralph-Wiggum, security tax).                      |
| `multi-plane-deploy`  | Deploy order for an app split across DB / runner / edge / static planes.                                             |
| `hotfix-and-rollback` | Outage decision: rollback vs flag vs forward hotfix; blast radius; verify; class-fix follow-up; ratchet.             |

## Templates (5) — `templates/`

| Template                           | What                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `template-agents-md` → `AGENTS.md` | Thin cross-tool baseline (stack, commands, conventions, do-nots).                               |
| `template-claude-md` → `CLAUDE.md` | Claude Code baseline: git-safety, pointer to AGENTS.md, definition-of-done, managed rule block. |
| `template-state-file` → `STATE.md` | Persistent loop/workflow memory across runs.                                                    |
| `template-automation-loop`         | Automation/loop starter (goal, gate, caps, the loop, scheduling, guardrails).                   |
| `template-mcp` → `mcp.json`        | MCP starter (Context7 + Playwright); merged by key on `add`.                                    |

## Reference docs (`docs/`)

`doc-install` / repo-root `INSTALL.md` (agent _use this_ / _update to latest_ contract),
`usage` (this guide's companion), `catalog` (this file), `external-practices` (Anthropic/Cursor
conventions), `agentic-patterns` (the 2026 agentic-coding pattern catalog behind these assets),
`loop-engineering`, `agent-harness-engineering`.
