# Methodology: Agentic Coding Patterns

> The patterns behind loadout's agentic assets. This is the **catalog of practices** —
> what each pattern is, when it applies, its failure mode, and which loadout asset
> encodes it. It is the "why" doc; the skills and rules are the "how."
>
> **Scope / no overlap:** [`external-practices.md`](./external-practices.md) covers
> authoring conventions (SKILL/rule frontmatter, progressive disclosure).
> [`loop-engineering.md`](./loop-engineering.md) covers the _economics_ of operating a loop
> (should you loop at all) and this project's harvest decision log.
> [`agent-harness-engineering.md`](./agent-harness-engineering.md) covers the harness
> layers. **This doc** is the coding-pattern catalog. Cross-link; don't restate.

---

## 0. The shift

The leverage in agentic coding moved from _writing one good prompt_ to _designing the
loop that prompts, acts, and verifies itself across many turns_. A coding agent is
`model + harness`; these patterns are the harness-level moves that make a long-horizon
task reliable instead of a hopeful one-shot. They come from a small set of primary
sources plus field practice, mapped here onto concrete loadout assets.

---

## 1. The pattern catalog

### 1.1 Workflows vs. agents (know which you're building)

A **workflow** is a fixed, predefined path (prompt chaining, routing, parallelization).
An **agent** dynamically decides its own steps and tool use. Prefer the simplest thing
that works: a deterministic workflow beats an autonomous agent when the path is known,
because it's cheaper and more predictable. Reach for autonomy only when the path can't be
hard-coded. Anthropic's five composable patterns — prompt chaining, routing,
parallelization, orchestrator-workers, evaluator-optimizer — are the vocabulary.

- **Encoded by:** loadout's `processes/workflows/*` (fixed recipes) vs. the
  `running-a-dev-cycle` skill (dynamic routing) and `agentic-loop` skill (autonomous
  in-task loop).

### 1.2 The outer loop + a stop condition written as a contract

Every non-trivial task is an outer loop: find the work → do one unit → verify against a
contract → record → decide the next unit → repeat until a _verifiable_ done. The single
most important artifact is the **acceptance contract** written before editing: end state,
evidence (the objective command/artifact that proves it), constraints, and a budget
(a hard ceiling of edit→verify cycles). Without it, the loop stops when it _feels_ done —
exactly when it's most likely wrong.

- **Encoded by:** `agentic-loop` skill + `agentic-loop.mdc` rule;
  `references/verification-and-stop-conditions.md`; workflow `stop_condition`/`gate` fields.

### 1.3 Evaluator-optimizer, and a checker that isn't the maker

One pass generates; a separate, independent pass evaluates against the contract and feeds
back; iterate until clean. It works when the criteria are clear and feedback demonstrably
improves the result — the case for code with tests. The guardrail: **the maker must not
be the sole checker.** The model that wrote the code rationalizes its own diff, so a fresh
context (a review sub-agent) grades shippable work.

- **Encoded by:** the `reviewer` / `security-reviewer` agents (the checker);
  `review-plan` / `review-build` (and `/review-plan` / `/review-build` — prefer a fresh
  chat); `root-cause-fix` and `agentic-loop`'s maker-checker step;
  `references/subagents-and-parallelism.md`.

### 1.4 Context engineering (attention is a finite, decaying budget)

Context is finite with diminishing returns — models develop _context rot_ as the window
fills. The goal is the **smallest set of high-signal tokens** that gets the job done, via:
**just-in-time retrieval** (keep light identifiers, pull content on demand) over
front-loading; **compaction** (summarize decisions/open-bugs/next-step, continue from the
summary) as the first lever for long-horizon coherence; **structured note-taking** (state
outside the window so a fresh context resumes); and **sub-agent isolation** (bulk
exploration burns tokens in a sub-agent that returns a 1–2k-token distilled summary).

- **Encoded by:** `agentic-loop/references/context-engineering.md`; the `explorer` agent;
  the `STATE.md` template.

### 1.5 Orchestrator-workers + parallelism + worktrees

A central agent decomposes a task and delegates units to workers — useful when subtasks
aren't known up front. Independent units run in parallel (sectioning); genuinely uncertain
changes can run as best-of-N (voting). File-level isolation via **git worktrees** lets
parallel agents edit without collisions. The ceiling is **your review bandwidth**: ten
parallel diffs you can't review is worse than two you can. Match concurrency to it, cap it
hard, and serialize the risky step (landing/merge).

- **Encoded by:** `orchestrating-parallel-agents` skill;
  `references/subagents-and-parallelism.md`.

### 1.5b Task topology graphs (units of one task)

Not every task is one loop, and not every parallel run is a queue of tickets. A
**nontrivial task** is triaged into **single-loop** (default), **pipeline** (sequential
stages with verify gates), or **graph** (parallel units + gates + integrate). Graph
requires proof: disjoint file allowlists and an independently runnable verifier per unit.
Interfaces are written to a shared contract _before_ implementers run; workers
(`implement-node`) may not edit it or reach outside their allowlist; the integrator
re-dispatches violators instead of hand-fixing across boundaries. A graph of unverified
agents is worse than one loop — refuse to escalate without verifiers.

- **Encoded by:** `task-topology`, `decompose`, `integrate` skills; `implement-node` rule
  - agent; workflow `build-as-graph`; plan/review amendments on `create-plan` /
    `review-plan` / `review-build`. Distinct from `orchestrating-parallel-agents` (N
    tickets) and constrained by `shared-working-tree` when that kit is installed.

### 1.6 Spec / contract-driven development

Write the intended behavior as a checkable spec/contract _before_ generating, then hold
the output to it. This is the same instinct as the stop-condition contract, scaled to a
feature: the spec is the shared artifact the maker builds to and the checker verifies
against. It turns "looks done" into "meets the spec."

- **Encoded by:** `create-plan` / `review-plan` / `review-build` / `planning-a-change`
  (the plan is the spec; the build review proves it), `agentic-loop`'s acceptance
  contract, `definition-of-done.mdc` (the outer contract), `/plan` → `/review-plan` →
  `/review-build`.

### 1.7 Plan-first (separate deciding from doing)

For ambiguous or large work, produce a read-only plan and get it right before any edit.
It surfaces trade-offs and unknowns while they're cheap, and gives the executor a spec to
build to. Skip it for one-liners; it's a tax on trivial work.

- **Encoded by:** `deep-dive` (seed → recommendation before a plan), `create-plan`,
  `review-plan`, `planning-a-change`, `plan-then-build`, `/plan`, `/review-plan`,
  `running-a-dev-cycle` (PLAN phase), `getting-started`.

### 1.8 Progressive disclosure (skills load lean, expand on demand)

A skill's metadata is the first disclosure level — just enough for the agent to know when
to use it. The body loads on trigger; references load only when needed. Many installed
skills stay cheap because detail is deferred. Keep the always-read part lean; push depth
into one-level-deep references.

- **Encoded by:** every loadout `SKILL.md` + `references/`; enforced by `skill-author` and
  `loadout doctor`.

### 1.9 The agent-computer interface (tool design is prompt engineering)

A tool is a contract between deterministic code and a non-deterministic agent. Its name,
description, params, and **result shape** are loaded into context every turn and steer
behavior — give them system-prompt-level attention. Fewer, higher-signal tools;
namespacing; semantic identifiers over cryptic ones; token-efficient results; errors that
steer toward a fix. Small description refinements yield outsized gains.

- **Encoded by:** `agent-tool-design` skill; `no-regex-for-semantics.mdc`.

### 1.10 Root cause over symptom (prove the cause, fix the class)

The line that throws is rarely the root. Descend the causal chain until you reach a
controllable node whose correct fix kills the whole _class_ of failure, prove it explains
100% of the behavior, then fix at that layer and lock it with a regression test that fails
before and passes after. Reject bandaids (special-casing, threshold nudges, swallowed
errors, fixing the gate not the code).

- **Encoded by:** `root-cause-fix` skill + `references/{root-cause-descent,
solution-selection}.md`; `debugging-an-issue`; `regression-test.mdc`, `no-shortcuts.mdc`.

### 1.11 Observability-first (runtime evidence before source)

For a production/staging issue, read the logs and traces before reading code: get
correlation ids, query for the error/latency signal, decode the error body, then narrow to
the code path. Runtime evidence beats guessing at the source.

- **Encoded by:** `debugging-with-observability` skill; `observability-first.mdc`.

### 1.12 Close the UI feedback loop (UI claims require UI evidence)

Backend work verifies itself (tests, exit codes); frontend work doesn't — and agents
respond by faking it (injecting state to "reach" a screen, trusting the app's own
success toast, declaring a CSS fix done from the diff alone). The pattern: treat the
rendered UI as ground truth. Mechanical checks on markup first (cheap, deterministic),
screenshots at decision points (vision is expensive), act through the real interface,
re-verify after every mutating action, and attach the artifacts so a human can validate.
Hybrid DOM+vision beats either alone — the 2026 GUI-agent consensus.

- **Encoded by:** `ui-evidence.mdc`; `reviewing-ui` (+ `references/ui-evidence.md`, which
  ships a reusable persistent-browser/one-shot-probe harness); `recreating-a-design`.

### 1.13 The dogfooding quality loop (compounding rubric)

Point the agentic loop at the product itself: drive real customer scenarios through the
running app, judge every artifact against a rubric (deterministic checks for exact
things, judgment grades for the rest), exercise every mutation path, and fix defects at
the root with fail-on-revert tests. Two things make repeated runs compound instead of
repeat: a **durable ledger** (known-fixed and known-open issues, so no cycle re-discovers
old findings) and a **growing rubric** (every new failure mode becomes a named check the
next cycle runs automatically — the ratchet applied to product quality).

- **Encoded by:** `exercising-the-product` (+ `references/{session-state,quality-rubric}.md`);
  `reviewing-ui`'s `UI-REVIEW.md` decision log; the `run-quality-loop` workflow.

### 1.14 Session-scoped live-surface verification

Unit tests and a clean diff do not prove a session's new UI/API/CLI/MCP
surfaces work. Inventory the session from git (not memory), write a
falsifiable claim per surface, exercise at the _real_ layer with pasted
evidence, then class-kill failures. Same-session tests the maker wrote are
circular — the live surface is the oracle. Distinct from full-product
dogfood and from code-wrap review.

- **Encoded by:** `verifying-session-surfaces` (`/verify-surfaces`);
  `session-inventory.sh` RECEIPT; `ui-evidence` for UI rows; `root-cause-fix`
  for BROKEN; `flight-checker` as maker≠checker. Cursor Team Kit
  `verify-this` is the one-claim cousin; Anthropic's 2026 verification-loop
  essay is the loop shape.

### 1.15 Research-before-integrate

Before adopting an unfamiliar API/library, research it from primary sources
(official docs → examples → changelog → vetted community), distill it into an
implementation-ready reference with versions and gotchas, and cite sources with an access
date. A future session (or teammate) then builds without re-researching.

- **Encoded by:** `researching-a-dependency` skill; `documentation-updates.mdc`.

---

## 2. The failure modes to design against

### 2.1 The "Ralph"/self-declared-done loop

An agentic loop executes a tool, evaluates the result, and decides the next move — but if
the completion signal is the _agent's own judgment_, it emits "done" before the work is
done. You're running one if you lack a real (external) verifier, your done-metric is the
model's opinion, or you have no hard caps. Fixes: an objective external gate, a separate
model/agent deciding completion, and hard budget/iteration caps.

- **Guarded by:** the stop-condition contract + budget (`agentic-loop`), the independent
  checker (`reviewer`), and `loop-preflight`'s Ralph-Wiggum self-test.

### 2.2 Goal drift

Over a long loop, "do not touch" constraints fade from attention (they drift out of the
window by turn ~N). Fix: re-read the base spec/contract each iteration; keep constraints in
a durable file, not just the conversation.

- **Guarded by:** `STATE.md`, compaction, and re-reading the contract each cycle.

### 2.3 Comprehension debt & cognitive surrender

The faster the loop ships code you didn't hand-write, the wider the gap between the repo
and your understanding — and the stronger the pull to stop forming an opinion. Read every
diff; don't merge what you can't explain; periodically break code on purpose to prove the
gates still catch it.

- **Guarded by:** the "risks the loop does NOT remove" section of `agentic-loop`; human
  review stays in the path for anything that ships.

### 2.4 Skills/tools as injection vectors

An installed skill or MCP is instructions the agent will follow — malicious text can hide
in a description. Treat inbound assets as untrusted: read them, pin to tags, review diffs.

- **Guarded by:** `audit-external-skills.mdc`; `loadout doctor`'s injection lint.

### 2.5 Over-parallelization

Concurrency beyond your review bandwidth converts speed into unreviewed risk. Cap it;
serialize merges.

- **Guarded by:** `orchestrating-parallel-agents`' hard concurrency cap + serial landing;
  `task-topology` / `build-as-graph` wave cap (≤3) + serial `integrate`.

---

## 3. Pattern → asset map

| Pattern                                      | Primary loadout asset(s)                                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows vs agents                          | `processes/workflows/*`, `running-a-dev-cycle`, `agentic-loop`                                                                                                                        |
| Outer loop + stop contract                   | `agentic-loop` (+ rule), `verification-and-stop-conditions`                                                                                                                           |
| Evaluator-optimizer / maker≠checker          | `reviewer`, `security-reviewer`, `review-plan`, `review-build`, `/review-plan`, `/review-build`, `root-cause-fix`, `security-pass`                                                    |
| Context engineering                          | `context-engineering` ref, `explorer`, `STATE.md`                                                                                                                                     |
| Orchestrator-workers / parallel / worktrees  | `orchestrating-parallel-agents`, `clear-the-queue`, `subagents-and-parallelism`                                                                                                       |
| Task topology graphs (one task → units)      | `task-topology`, `decompose`, `integrate`, `implement-node`, `build-as-graph`                                                                                                         |
| Shared trunk (parallel agents, one checkout) | `shared-working-tree`, `no-stash`, `git-safety`, `committing-on-shared-trunk`                                                                                                         |
| Spec/contract-driven                         | `create-plan`, `review-plan`, `review-build`, `plan-then-build`, `planning-a-change`, `definition-of-done`, `decompose` (shared contract)                                             |
| Plan-first                                   | `deep-dive`, `create-plan`, `review-plan`, `review-build`, `plan-then-build`, `/plan`, `/review-plan`, `/review-build`, `planning-a-change`, `running-a-dev-cycle`, `getting-started` |
| Progressive disclosure                       | every `SKILL.md`, `skill-author`, `doctor`                                                                                                                                            |
| ACI / tool design                            | `agent-tool-design`, `no-regex-for-semantics`                                                                                                                                         |
| Root cause over symptom                      | `root-cause-fix`, `debugging-an-issue`, `debug-production`, `regression-test`                                                                                                         |
| Observability-first                          | `debugging-with-observability`, `debug-production`, `observability-first`                                                                                                             |
| Research-before-integrate                    | `researching-a-dependency`, `dependency-bump`, `documentation-updates`                                                                                                                |
| Close the UI feedback loop                   | `ui-evidence`, `reviewing-ui`, `recreating-a-design`                                                                                                                                  |
| Dogfooding quality loop                      | `exercising-the-product`, `reviewing-ui`, `run-quality-loop`                                                                                                                          |
| Self-declared-done guard                     | `loop-preflight`, `agentic-loop`, `reviewer`                                                                                                                                          |
| Incident stabilize then class-fix            | `hotfix-and-rollback`, `debug-production`                                                                                                                                             |
| Safe structural change                       | `safe-refactor`, `refactor-discipline`                                                                                                                                                |
| Expand/contract schema                       | `ship-a-migration`, `writing-a-migration`, `db-migration-safety`                                                                                                                      |
| Bootstrap the harness                        | `bootstrap-project`, `harness-setup`                                                                                                                                                  |

---

## 4. Sources

Primary sources behind these patterns (accessed 2026-07-01):

- Anthropic, "Building effective agents" — the five workflow patterns, agents vs
  workflows, and the agent-computer interface appendix.
  <https://www.anthropic.com/research/building-effective-agents>
- Anthropic, "Effective context engineering for AI agents" — compaction, just-in-time
  retrieval, minimal high-signal tokens, context rot, note-taking, sub-agent isolation.
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>
- Anthropic, "Equipping agents for the real world with Agent Skills" — progressive
  disclosure; SKILL.md metadata as the first disclosure level.
  <https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills>
- Claude Platform Docs, "Agent Skills" — the SKILL.md format and on-demand loading.
  <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
- Geoffrey Huntley, "Ralph Wiggum as a software engineer" and "everything is a ralph
  loop" — the agentic loop and the self-declared-done failure mode.
  <https://ghuntley.com/ralph/> · <https://ghuntley.com/loop/>
- GitHub, "spec-kit" — spec-driven development toolkit.
  <https://github.com/github/spec-kit>
- Addy Osmani, "The Code Agent Orchestra," and Augment, "Git Worktrees for Parallel AI
  Agent Execution" — parallel agents, worktree isolation, diff-first review, matching
  parallelism to review bandwidth.
  <https://addyosmani.com/blog/code-agent-orchestra/> ·
  <https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution>
- Jonathan Fulton, "AI Has a UX Validation Problem" (accessed 2026-07-04) — the broken
  frontend feedback loop, agents bypassing the UI to fake validation, evidence-for-humans.
  <https://medium.com/jonathans-musings/ai-has-a-ux-validation-problem-cf8d93ea4e92>
- Zylos, "Computer Use and GUI Agents in 2026: State of the Art" (accessed 2026-07-04) —
  hybrid DOM/accessibility + vision consensus, act-then-re-verify, agents not recognizing
  their own failures.
  <https://zylos.ai/research/2026-02-08-computer-use-gui-agents/>
