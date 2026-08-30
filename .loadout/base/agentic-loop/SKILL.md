---
name: agentic-loop
description: >
  Run a non-trivial coding task as a verifiable perceive->plan->act->observe->verify->reflect
  loop instead of one-shot prompting. Use for multi-step / long-horizon work, when you need a
  stop condition you cannot fake, when managing your own context budget, or when deciding to
  spawn sub-agents / parallelize. Covers the stop-condition contract, ground-truth
  verification, maker-checker, durable memory, and bounded autonomy. Triggers on "agentic
  loop", "loop engineering", "context engineering", "stop condition", "maker-checker", "verify
  before done", "manage context", "spawn subagents". Anti-triggers: full dev-cycle routing /
  "build this end to end" -> running-a-dev-cycle; proving a root cause + class fix ->
  root-cause-fix; a quick everyday bug -> debugging-an-issue; designing a product's agent
  tools -> agent-tool-design; running many items in parallel -> orchestrating-parallel-agents.
---

# Agentic loop

The leverage in agentic coding moved from *writing one good prompt* to *designing the loop
that prompts, acts, and verifies itself across many turns*. This skill is the discipline for
running a development task as a reliable loop — not a wall of instructions you hope the model
follows once.

Two loops are always in play:

- **Inner loop** (every turn): perceive -> reason -> act (tool call / edit) -> observe the
  result -> reason again against the new state. The model already runs this.
- **Outer loop** (the task): find the work -> do one unit -> verify against a contract ->
  record what changed -> decide the next unit -> repeat until a *verifiable* done.

Loop engineering is designing the outer loop well: a tight goal contract, ground-truth
verification, durable state, bounded autonomy, and a maker separate from the checker.

## When to use

- A task spanning many tool calls or a long horizon (multi-file feature, migration, audit,
  "take this from idea to shipped").
- Any time you're tempted to "just do it all in one turn" on something non-trivial.
- When deciding whether to spawn sub-agents or parallelize.
- When context is filling up and quality is starting to drift.

**Anti-patterns (use the other asset instead):**

| Situation | Use instead |
| --- | --- |
| Full dev cycle, "build this end to end", autonomous mode | `running-a-dev-cycle` |
| Prove a root cause + ship a no-bandaid class fix | `root-cause-fix` |
| A quick everyday bug (red test, typecheck, wrong value) | `debugging-an-issue` |
| Designing the *product's* agent-facing tools / MCP | `agent-tool-design` |
| Running N independent work items at once | `orchestrating-parallel-agents` |
| Splitting one task into pipeline/graph units | `task-topology` → `build-as-graph` (default remains this single loop) |
| Large/ambiguous task needing a written plan first | `create-plan` / `planning-a-change` (or Plan mode) |

This skill is the *connective tissue* above those: it says how to structure the loop and hand
off to them.

## The five levers of a good loop

### 1. A stop condition written as a contract, not a wish

Before starting a non-trivial task, write an explicit acceptance contract (in a `TodoWrite`
item, a scratch note, or the PR body):

| Field | Weak | Verifiable |
| --- | --- | --- |
| **End state** | "improve X" | "`parseDuration('90m')` returns `5400`; the new case is covered" |
| **Evidence** | "looks done" | "the project's test + typecheck gate exits 0; a new regression test fails on revert" |
| **Constraints** | (unstated) | "no `any`; no public-API change; no new always-on rule" |
| **Budget** | (unbounded) | "stop after N edit-verify cycles; escalate if still red" |

The model stays the executor; the contract is the acceptance test it must pass before
claiming done. The outer contract for a *shippable* change is `definition-of-done.mdc`. See
`references/verification-and-stop-conditions.md` to author one and wire it to the repo's gate.

### 2. Ground-truth verification, and a checker that isn't the maker

The model that wrote the code grades its own homework too generously. Get an *independent*
signal:

- **Objective ground truth first:** the project's typecheck, the affected test file,
  the linter on edited files, and a regression test that fails before your fix and passes
  after (`regression-test.mdc`). A red test / type error is the honest signal — treat it as
  what keeps the loop honest, not an annoyance to suppress (`no-shortcuts.mdc`, `no-any.mdc`).
- **Preserve mistakes.** When a check fails, record *why* so the loop learns instead of
  re-attempting the same dead end.
- **Separate the checker.** For anything you'll ship, get a review from a fresh, clean
  context — the `reviewer` (or `security-reviewer`) agent, or in Cursor a `bugbot` /
  `security-review` sub-agent — that runs the tests and reads the diff against the contract.
  See `references/subagents-and-parallelism.md`.

### 3. Durable external memory (the repo remembers; you forget)

A long task outlives any single context window. State must live *outside* the window:

- **`TodoWrite`** is your in-task working memory — one item per unit of work, marked
  `in_progress`/`completed` in real time, with failure notes preserved.
- For long / cross-session work, a durable file (a `STATE.md` from the state-file template, a
  `docs/` plan, or the ticket) is the spine a *fresh* context reads to resume exactly where
  the last one stopped. The model forgets between runs; the repo does not.
- Prefer **just-in-time retrieval** over front-loading: keep light identifiers (paths,
  symbols, grep queries) and pull content in with `Read`/`Grep`/`Glob` when needed.

### 4. A context budget you actively manage

Context is finite with diminishing returns ("context rot"): every token spent on stale tool
output or irrelevant files degrades attention on what matters. Find the *smallest set of
high-signal tokens* that gets the job done. When context fills on a long task, **compact**:
summarize decisions made / bugs open / files touched, and continue from the summary. Isolate
exploratory bulk in an `explorer` sub-agent that returns a distilled summary. Full playbook:
`references/context-engineering.md`.

### 5. Bounded autonomy (climb the ladder; don't leap)

Match how far you run unattended to how strong your verification is and to the repo's safety
rules:

| Level | What you do unattended | Human still in the path |
| --- | --- | --- |
| 0 | One turn at a time | Every turn |
| 1 | Investigate + report findings, no edits | You act on the findings |
| 2 | Draft the change; leave edits **unstaged** | You review every diff |
| 3 | A checker sub-agent gates the diff before you present it | You approve; the checker filters |
| 4 | Chain edit->verify->fix loops autonomously to a green contract | You audit the log + final diff |

You **never** climb past unstaged edits on git: never stage, commit, branch, push, or open a
PR unless the user explicitly asks (`commit-and-pr-conventions.mdc`). Autonomy applies to
*edit-and-verify*, not to git or destructive actions.

## The loop, step by step

1. **Frame** — Restate the goal as a contract (lever 1). Pick the mode (Plan for
   ambiguous/large; Agent for clear). Write the todos.
2. **Perceive** — Gather *just enough* context: `Grep`/`Glob`/semantic search to locate,
   `Read` the few high-signal files. Prefer an `explorer` sub-agent for broad unfamiliar
   sweeps (it returns a summary, keeping your window clean).
3. **Plan** — Decide the smallest next unit of work and its verification.
4. **Act** — Make the edit. One coherent unit at a time.
5. **Observe** — Run the verification for that unit (the linter, the targeted test,
   typecheck). Read the *actual* result; don't assume success.
6. **Verify against the contract** — Are the evidence conditions met? If not, record *why*
   and loop back to Plan. Respect the budget ceiling.
7. **Reflect / hand off** — On green: update todos, then for shippable work spawn the
   independent checker (lever 2). Summarize what changed. Leave edits unstaged.

## Risks the loop does NOT remove (design against them)

1. **Verification is still on you.** An unattended loop is a loop making mistakes unattended.
   "Done" is a claim, not a proof — the independent checker + the repo's test gates are what
   make it mean something. Never declare done on green typecheck alone.
2. **Comprehension debt grows faster.** The faster the loop ships code you didn't hand-write,
   the wider the gap between the repo and your understanding. Read what the loop produced;
   summarize it back; don't merge what you can't explain.
3. **Cognitive surrender.** Designing the loop with judgment is the multiplier; accepting
   whatever it returns to avoid thinking is the failure. Stay the engineer.

## Stop and ask

If you're still red after the budget ceiling, if verification is impossible to define, or if
the correct fix needs a scope/architecture decision the user owns — stop and report what you
tried and what's blocking, rather than thrashing or shipping a bandaid.

## Common pitfalls

- Loading whole large files "to be safe" -> wastes the attention budget. Grep to the relevant
  lines; read ranges.
- One giant edit across many files before any verification -> a failure you can't localize.
  Edit one unit, verify, repeat.
- Declaring done on the happy path only -> the contract must include a failure path and an
  edge case.
- Letting the maker grade itself -> skipping the independent checker on shippable work.
- Silently committing/pushing because the loop "finished" -> forbidden; leave edits unstaged.

## Pairs with

- skills: `root-cause-fix`, `create-plan`, `planning-a-change`, `reviewing-and-shipping`,
  `post-flight`, `orchestrating-parallel-agents`, `running-a-dev-cycle`, `task-topology`,
  `decompose`, `integrate`
- rules: `no-shortcuts`, `regression-test`, `definition-of-done`
- agents: `reviewer`, `explorer`, `implement-node`
- docs: `agentic-patterns`, `loop-engineering`
- runbooks: `loop-preflight`
- workflows: `run-autonomous-loop`, `plan-then-build`, `run-quality-loop`, `clear-the-queue`,
  `ship-a-feature`, `build-as-graph`
