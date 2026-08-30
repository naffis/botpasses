---
name: orchestrating-parallel-agents
description: >
  Run N independent work items at once with sub-agents in isolated git worktrees — bounded
  concurrency, full context per sub-agent, and a serialized landing gated by maker-checker. Use
  when asked to "do these in parallel", "knock out the next N tasks", "work the queue", or when
  several independent changes could run concurrently. Anti-triggers: one task as a loop ->
  agentic-loop; a single feature end to end -> running-a-dev-cycle / ship-a-feature; deciding
  whether to spawn ONE sub-agent -> the agentic-loop subagents reference; splitting ONE
  feature into verified file-bounded units -> task-topology / build-as-graph.
---

# Orchestrating parallel agents

Running several agents at once is a real speedup — and a real hazard, because two agents editing
the same files collide like two engineers committing to the same lines without talking. This
skill is the discipline for parallel work: isolate each item, cap concurrency to what you can
actually review, and serialize the risky step (landing).

## Shared-tree fork (check first)

If `shared-working-tree` (and usually `no-stash` / `git-safety`) is installed: **do not** create
per-item worktrees or branches. Keep every agent on the single local trunk checkout, never
stash, and when the user asks to commit use `committing-on-shared-trunk`. Collision protocol:
stop, leave the tree intact, ask. Use the worktree steps below only when that kit is **not**
installed, or when the user explicitly asks for worktree isolation.

## When to use

- A set of **independent** work items (tasks/tickets/fixes) that don't touch the same files.
- The user asks to do several at once, clear a queue, or "knock out the next N".

If items are coupled (they edit overlapping files, or one depends on another's output),
**sequence them** instead — run each to completion with `running-a-dev-cycle` or the
`ship-a-feature` workflow before starting the next.

## Step 1 — build the work set

Enumerate the items. For each, note the files/areas it will touch. **Any two items that touch
overlapping files must NOT run in parallel** — sequence them. If you're unsure whether two
overlap, sequence them. Confirm the set and the chosen concurrency before doing destructive
work; if the set is large or the request was vague, confirm scope first.

## Step 2 — choose concurrency (cap it hard)

- **1 item** → just run it inline (`running-a-dev-cycle` / `ship-a-feature`); no orchestration.
- **2-3 items** → run in parallel, each in its own worktree + sub-agent.
- **More than 3** → process in **waves of at most 3**. More than ~3 concurrent agents contend on
  CPU, on rate limits, and — most importantly — on *your review bandwidth*. Ten parallel diffs
  you can't review is worse than two you can. Never exceed the cap.

## Step 3 — isolate each item in a worktree

Give each parallel item its own git worktree + branch so their edits can't touch each other
(separate working directory, shared history):

```bash
git worktree add ../<repo>-<slug> -b <branch-name>   # one per item; prints the path
```

Each sub-agent does ALL its work in its own worktree path — never the main checkout.

## Step 4 — launch one sub-agent per item

Launch the sub-agents (in Cursor, `Task` with `subagent_type: generalPurpose`,
`run_in_background: true`). Sub-agents do **not** see this conversation, so each prompt must be
self-contained:

- The absolute **worktree path** — "do all work here; never the main checkout."
- The full task description + acceptance criteria (the sub-agent can't infer it).
- The instruction to follow `running-a-dev-cycle` (or `ship-a-feature`) to a green gate + a
  passing self-review, and to **stop before landing** — report back its branch/PR and status.
- The hard rules: no test-weakening, the gate must be green, `no-shortcuts`, edits stay unstaged
  / no merge (`commit-and-pr-conventions`).

Keep any shared external bookkeeping (issue tracker updates, PR comments) as YOUR job, not the
sub-agent's — sub-agents may lack that access.

## Step 5 — land serially, yourself, gated by maker-checker

Do **not** let sub-agents merge — concurrent merges race (each rebases on a moving base). As
each sub-agent reports a green result, land them **one at a time**:

1. Run the independent **checker** on the diff (the `reviewer` / `security-reviewer` agent, or a
   `bugbot` / `security-review` sub-agent) against that item's acceptance contract. A real
   finding goes back to that item's maker; don't land on a failing verdict.
2. Rebase the branch on the latest base and re-verify the gate is green **after** the rebase (a
   PR that was green can break once rebased). See `rebasing-a-branch`.
3. Merge/open the PR **only if the user asked** to land it (`commit-and-pr-conventions`);
   otherwise present the branch + verdict for review.
4. Wait for this item to be fully done before landing the next, so the next rebases on the newer
   base.
5. Remove the worktree once the item is fully landed: `git worktree remove <path>`.

## Step 6 — report

After each item and at the end, a compact status table:

| Item | Branch/PR | Gate | Checker verdict | Landed |
| --- | --- | --- | --- | --- |
| task-A | feat/a | pass | SAFE | yes |
| task-B | feat/b | fail (flaky) | — | no |

For anything not landed, state exactly where it stopped, why, and what you need from the user.

## Guardrails

- **One landing at a time**, always rebased on the latest base.
- **Hard concurrency cap** (default 3); wave larger sets.
- **Never parallelize items that edit overlapping files.**
- **Never land** an item whose gate isn't green or whose checker verdict isn't SAFE.
- If the shared base (its CI) goes red, **stop starting new landings** and fix forward — a
  broken base blocks everyone.
- Match parallelism to your review bandwidth; you are the review ceiling.

## Pitfalls

- Launching N sub-agents because the user said "do them all" — wave them in groups of <=3.
- Letting sub-agents merge — they stop at a green result; YOU land serially.
- Forgetting sub-agents lack context — put the full task + worktree path + procedure pointer in
  every prompt.
- Cleaning up a worktree before its landing is confirmed.

## Pairs with

- skills: `agentic-loop`, `running-a-dev-cycle`, `rebasing-a-branch`, `reviewing-and-shipping`,
  `committing-on-shared-trunk`, `task-topology`, `integrate`
- agents: `reviewer`, `security-reviewer`
- rules: `no-shortcuts`, `commit-and-pr-conventions`, `shared-working-tree`, `no-stash`, `git-safety`
- workflows: `clear-the-queue`, `build-as-graph` (different scope: units of one task, not a ticket queue)
- docs: `agentic-patterns`
