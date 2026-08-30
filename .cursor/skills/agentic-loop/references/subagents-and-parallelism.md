# Sub-agents & parallelism

The single most useful structural move in a loop is **separating the agent that makes from the
agent that checks**, and the single biggest speedup is **parallelizing independent work**.
Both are about giving each unit of work a clean, focused context.

## Why a sub-agent (context isolation)

A sub-agent runs with its **own clean context window**, does focused work (which may burn tens
of thousands of tokens exploring), and returns only a **distilled summary** (often 1-2k
tokens). The detailed work stays isolated; your window keeps only the conclusion. This is both
a context-budget win (see `context-engineering.md`) and a correctness win (a fresh checker
isn't anchored on the maker's reasoning).

Cost: each sub-agent runs its own model + tool calls, so spend them where a second opinion or
an isolated deep-dive is worth paying for — not for trivial lookups you can do inline.

## Loadout agents + Cursor sub-agent types

loadout ships five cross-tool agents you dispatch with "use the `<name>` subagent":

| Agent | Use it for |
| --- | --- |
| `explorer` | Broad read-only codebase sweeps ("how does X work across the repo?"). Returns a summary; keeps your window clean. |
| `reviewer` | The maker-checker checker: independent diff review vs. stated intent, with a verdict. |
| `security-reviewer` | Injection / authz / secrets / unsafe data handling (strong model, high effort). |
| `ci-watcher` | Monitor a PR's CI; concise pass/fail with links to failures. |
| `implement-node` | One unit from a `task-topology` / `decompose` TASK.md — hard allowlist, unit verifier, PASSED/FAILED only. |

In Cursor you additionally have native `Task` sub-agent types — `explore`, `generalPurpose`,
`shell`, `best-of-n-runner`, and the read-only `bugbot` / `security-review` reviewers. Map
them to the loadout agents where they overlap (e.g. `explore` == `explorer`, `bugbot` plays
the `reviewer` role). Launch reviewers read-only, one at a time, fresh each time (no resume).

Prefer `Grep`/`Glob`/`Read` **directly** for a needle query (a specific symbol, a known file)
— that is faster than spawning a sub-agent. Reach for `explorer`/`explore` only when the query
is genuinely broad or the area is unfamiliar.

## Maker-checker (the verifier that isn't the maker)

For anything you will present as shippable:

1. **Maker** (you, or a `generalPurpose` sub-agent): implement to the contract, run the
   objective gates (typecheck, the affected test, the linter).
2. **Checker** (a fresh context — the `reviewer` / `security-reviewer` agent, or a
   `bugbot` / `security-review` sub-agent): give it the diff + the acceptance contract. It
   runs the tests, reads the diff against repo conventions, and reports a verdict (SAFE TO
   MERGE / MERGE AFTER FIXES / DO NOT MERGE) with evidence per finding.
3. You reconcile: a real finding loops back to the maker; a false positive is noted and
   dismissed with reasoning.

The checker is adversarial by design — "reject anything not verifiably done." The executor
never grades its own stop condition.

## Parallelism (independent work at the same time)

- **Parallel tool calls:** when several reads/searches are independent (no output feeds
  another's input), issue them in a **single message** — multiple `Read`/`Grep`/`Glob` calls,
  or multiple sub-agent launches, at once. Only serialize when there's a true data dependency.
  This is the cheapest latency win available.
- **Parallel sub-agents:** launch multiple agents in one message for independent slices (e.g.
  explore two subsystems at once, or run a `reviewer` + `security-reviewer` together).
  Synthesize their summaries when they return.
- **Voting / best-of-N:** for a change with real uncertainty, run N attempts (in Cursor via
  `best-of-n-runner`, each in its own worktree) and pick the best — the evaluator-optimizer
  pattern across candidates. Reserve for genuinely hard or high-value changes; it multiplies
  cost.

For a full workflow that runs many independent items in parallel (bounded concurrency,
serial landing), use the `orchestrating-parallel-agents` skill — and check whether
`shared-working-tree` is installed first.

For splitting **one** task into file-bounded units with shared contracts, use
`task-topology` / `build-as-graph` (not the queue orchestrator).

## Shared trunk vs worktree isolation

**If `shared-working-tree` is installed:** keep every agent on one local trunk checkout. Do
**not** create per-agent branches or worktrees unless the user explicitly asks. Do **not**
stash. On commit, land the whole eligible tree (`committing-on-shared-trunk`). Collision
protocol: stop, leave the tree intact, ask.

**Otherwise (worktree isolation):** give each parallel attempt its own git worktree + branch
so edits cannot touch each other. Match parallelism to review bandwidth; merge/commit/push of
any worktree branch waits for the user's explicit request (`commit-and-pr-conventions.mdc`).

Best-of-N via `best-of-n-runner` (separate worktrees) remains opt-in for hard experiments; it
is not the default when `shared-working-tree` is installed.

## When NOT to delegate

- A needle lookup (`Grep` for a symbol) — do it inline, don't spawn an agent.
- A change small enough that the spawn overhead + summary round-trip costs more than just
  doing it.
- Anything where you need the *full* detail in your own window afterward (a sub-agent returns
  a summary, not its raw context).

## Checklist

- [ ] Broad/unfamiliar exploration? -> `explorer` sub-agent (summary, clean window).
- [ ] Reads/searches independent? -> issue them in ONE message (parallel).
- [ ] Shippable? -> run an independent checker (`reviewer`/`security-reviewer`) before
      presenting.
- [ ] High-value + uncertain change? -> consider best-of-N (worktrees) only if shared-tree kit is off / user asks.
- [ ] About to spawn an agent for a one-line lookup? -> just do it inline.
- [ ] Parallelism <= my review bandwidth; honor shared-working-tree / no-stash if installed; no git action without explicit ask?
