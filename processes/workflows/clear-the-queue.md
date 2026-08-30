---
name: clear-the-queue
uses:
  rules: [no-shortcuts, commit-and-pr-conventions, definition-of-done, regression-test, testing-conventions]
  skills: [orchestrating-parallel-agents, running-a-dev-cycle, planning-a-change, writing-tests, rebasing-a-branch, reviewing-and-shipping, writing-commit-messages, opening-a-pr]
  agents: [reviewer, security-reviewer]
gate: "each landed item: its acceptance contract met, checker SAFE, typecheck + test + lint green after rebase onto latest base"
stop_condition: "every in-scope queue item is landed or explicitly deferred with reason; no item merged without maker≠checker; worktrees cleaned up"
state: ".loadout/state/clear-the-queue.md"
---

# Clear the queue

Fan out independent work items, cap concurrency to review bandwidth, and serialize landing.
This is the named recipe around `orchestrating-parallel-agents` — use it when the user says
"do these in parallel", "knock out the next N", or "clear the queue." Do **not** use it for
one coupled feature (`ship-a-feature` / `plan-then-build`), one long loop
(`run-autonomous-loop`), or splitting **one** task into file-bounded units
(`build-as-graph` / `task-topology`).

**Shared-tree fork:** if `shared-working-tree` / `no-stash` / `git-safety` are installed, do
**not** create per-item worktrees. Keep every agent on the single local trunk checkout and
land with `committing-on-shared-trunk` when the user asks to commit. Equip those ids (plus
the skill) when that is the project's parallel-agent model.

**Equip note:** each parallel item still needs a per-item procedure. This `uses:` block
includes `running-a-dev-cycle` + planning/tests/shipping primitives. If items are ordinary
features, also vendor `ship-a-feature`'s remaining pieces (or the full `ship-a-feature`
workflow kit). If an item is high-stakes, run it alone via `plan-then-build` instead of
parallelizing it.

1. **Build the work set** — enumerate items with acceptance criteria and likely file touch
   sets. Write them into the state file. **Any two items that touch overlapping files must
   sequence, not parallelize.** If unsure, sequence. Confirm the set and chosen concurrency
   with the user when the request was vague or the set is large.
2. **Cap concurrency hard** — 1 item → run inline (`running-a-dev-cycle` / `ship-a-feature`),
   no orchestration. 2–3 → parallel. More than 3 → waves of at most 3. Never exceed the cap;
   ten unreviewed diffs are worse than two reviewed ones (`docs/agentic-patterns.md`
   over-parallelization).
3. **Isolate** — default: one git worktree + branch per parallel item (sub-agents work only
   in their worktree). **If `shared-working-tree` is installed:** skip worktrees; all agents
   share the trunk checkout (see `orchestrating-parallel-agents` shared-tree fork).
4. **Launch self-contained sub-agents** — each prompt must include: work location (worktree
   path **or** "shared trunk checkout"), full task + acceptance criteria, procedure pointer
   (`running-a-dev-cycle` or `ship-a-feature`), hard rules (`no-shortcuts`, gate must stay
   green, stop before landing, never stash), and "edits unstaged / no merge unless the user
   already authorized landing." Shared bookkeeping stays with the orchestrator.
5. **Land serially, gated by maker≠checker** — as each item reports green:
   1. Dispatch `reviewer` (and `security-reviewer` when the item touches auth, input, data
      access, secrets, or external calls) against that item's acceptance contract.
   2. On a failing verdict, send findings back to that item's maker — do not land.
   3. `rebasing-a-branch` onto the latest base; re-run the gate **after** the rebase.
   4. Merge/open the PR only if the user asked (`commit-and-pr-conventions`); otherwise
      present branch + verdict.
   5. Finish one landing before starting the next so the next rebases on the newer base.
   6. Remove the worktree when the item is fully done.
6. **Base goes red → stop new landings** — fix forward on the shared base before continuing.
   Never weaken tests to unblock the queue.
7. **Report** — keep a status table in the state file (item / branch / gate / checker /
   landed). End with exactly what remains, why, and what you need from the user.

Never let sub-agents merge concurrently. Never parallelize overlapping edits. Never land
without a SAFE checker verdict and a green post-rebase gate.
