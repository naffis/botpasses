# Using loadout

How to install loadout, how each kind of asset loads and how you invoke it, and how the
pieces work together. For a one-line description of every asset, see
[`catalog.md`](./catalog.md).

> **New to a project and not sure where to begin?** Run **`/start`** (or ask
> _"I want to build X — what should I do?"_). The `getting-started` skill clarifies the
> goal, picks the right workflow, decides manual vs autonomous loop, and hands you a
> ready-to-run kickoff prompt.

---

## 1. Mental model

`coding agent = model + harness`. loadout is a library of **harness components** plus a CLI
to install them. Each component lives where it loads:

| Asset                        | What it is                                        | Loads / triggers                                                               |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Rule** (`.mdc`)            | A persistent _constraint_ — no steps to run       | Always, on matching files, when the agent judges it relevant, or on `@mention` |
| **Skill** (`SKILL.md`)       | An invokable _procedure_ with a beginning and end | When your request matches its description, or you call it by name              |
| **Command** (`.md`)          | A repeatable action                               | When you type `/name`                                                          |
| **Subagent** (`.md`)         | A delegated task in its own context               | When the main agent dispatches it (or you ask for it)                          |
| **MCP server**               | External tool/data access                         | At session start, from `.mcp.json` / `.cursor/mcp.json`                        |
| **Hook** (`hooks.json`)      | Deterministic, must-happen-every-time enforcement | At lifecycle points (after edit, before commit, session start)                 |
| **Template / doc / runbook** | Starter files and reference material              | You read/use them; the CLI vendors them into the project                       |

The golden rule: **a constraint is a rule, a procedure is a skill, must-happen enforcement
is a hook, standing knowledge is `AGENTS.md`.**

---

## 2. How each asset type loads and how you call it

### Rules (`.mdc`)

A rule's frontmatter decides _when it loads_. Four modes:

| Mode                | Frontmatter                          | How it triggers                                        | Use for                                                                       |
| ------------------- | ------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **Always**          | `alwaysApply: true`                  | Loaded on every request                                | A few short, universal constraints (kept tiny — every token loads every time) |
| **Auto (glob)**     | `globs: [...]`, `alwaysApply: false` | Attaches when a matching file is in context            | Language/area constraints (e.g. `**/*.ts`)                                    |
| **Agent-requested** | `description:` set, no globs         | The agent pulls it in when it judges the rule relevant | Situational conventions                                                       |
| **Manual**          | no description, no globs             | Only when you `@rule-name` it in chat                  | Rarely-needed references                                                      |

- **In Cursor:** rules live in `.cursor/rules/*.mdc` and load per the table above. `@rule-name` forces one in.
- **In Claude Code:** there's no native `.mdc`. `loadout add` _projects_ a rule's body into a managed block in `CLAUDE.md` so the same constraint applies. Genuinely cross-tool baseline conventions belong in `AGENTS.md`.
- You generally don't "call" a rule — you rely on it loading. To check which are active in Cursor: Settings → Rules.

### Skills (`SKILL.md`)

A skill is selected primarily by its **description** — write requests that match it, and the
agent invokes it. You can also call one explicitly:

- **Claude Code:** `/skill-name` (e.g. `/planning-a-change`), or just describe the task and let it auto-trigger. Delivered via the plugin (`/plugin install core-engineering@loadout`).
- **Cursor:** skills load from `.cursor/skills/<name>/`; the agent invokes one when your request matches its description. `loadout add <skill>` vendors it.
- Skills use **progressive disclosure**: only the lean `SKILL.md` body loads on trigger; reference files load on demand. So having many installed is cheap until used.

Example: "plan and ship the auth refactor" will pull in `planning-a-change` then
`reviewing-and-shipping`; or run `/planning-a-change` to force it. A half-formed
thought (`deep dive: should we …` / `dig in: checkout double-charges`) runs
`deep-dive`: classify, investigate, recommend. It does not implement.

### Commands

Type the slash command: `/start`, `/plan`, `/review-plan`, `/review-build`,
`/verify-surfaces`, `/post-flight`, `/changelog`.
Commands are explicit, repeatable actions. `loadout add <command>` vendors them to
`.cursor/commands/<filename>.md` (Cursor) and `.claude/commands/<filename>.md` (Claude Code);
Claude Code can alternatively get them via the plugin marketplace.

**Planning + review loop (Cursor-friendly):**

| Command            | Runs                         | When                                                                             |
| ------------------ | ---------------------------- | -------------------------------------------------------------------------------- |
| `/plan <task>`     | `create-plan`                | Multi-file or uncertain work. Prefer Plan Mode. Skip one-sentence diffs.         |
| `/review-plan`     | `review-plan`                | After a plan, before coding. Prefer a fresh chat.                                |
| `/review-build`    | `review-build`               | After implementation, before calling it done. Prefer a fresh chat.               |
| `/post-flight`     | `post-flight`                | End-of-session review-and-FIX (ask vs ship, sibling sweep, independent checker). |
| `/verify-surfaces` | `verifying-session-surfaces` | Exercise this session's live surfaces; root-cause-fix what breaks.               |

`no-shortcuts` is always on and backs all three: no stubs, no unverified "green", read
before asserting. For hard problems, run `/plan` across two models in parallel (worktrees)
and merge the best plan.

### Subagents

A subagent runs in its own context window and reports back, which keeps your main context
clean and lets the maker differ from the checker.

- Dispatch by asking: _"use the **reviewer** subagent on this diff"_ or _"use **explorer** to find where sessions are handled."_
- Both tools load custom subagents from a per-tool dir: Claude Code from `.claude/agents/`, Cursor from `.cursor/agents/`. `loadout add <agent>` vendors the persona into both; Claude Code can also get them via the plugin.

### MCP servers

Configured in `.mcp.json` (Claude Code) / `.cursor/mcp.json` (Cursor) and loaded at session
start. `loadout add template-mcp` merges a starter (Context7 + Playwright) **by key** without
overwriting your existing servers. Treat any external MCP as trusted prompt text — see the
`audit-external-skills` rule.

### Hooks

Deterministic scripts at lifecycle points (after edit, before commit, session start).
Principle: **success is silent, failures are verbose.** Use a hook when something must
happen every time (format-on-write, typecheck/lint gate, block destructive commands,
approval before push). See the [`harness-hooks`](../processes/runbooks/harness-hooks.md)
runbook for ready-to-paste `hooks.json` + scripts. loadout ships one hook directly: the
SessionStart update-notify hook, installed by `loadout init`.

---

## 3. Installing and consuming

**Agent shortcut:** when the user points at this repo and says _use this_ or _update to
latest_, follow repo-root [`INSTALL.md`](../INSTALL.md) (or the `equipping-loadout` skill).
Do not invent a different path.

loadout ships across three layers; use whichever fits.

### A. Claude Code plugins (skills, commands, subagents)

```bash
/plugin marketplace add naffis/loadout
/plugin install core-engineering@loadout
/plugin install meta@loadout
/plugin update core-engineering
```

### B. Cursor rules (Remote Rules — one time per machine)

Cursor → **Settings → Rules and Commands → Remote Rule (GitHub)** → paste
`https://github.com/naffis/loadout`. Rules auto-sync on push.

### C. Vendored assets (the CLI)

```bash
npx github:naffis/loadout init          # detect tools, scaffold, install notify hook, lockfile
npx github:naffis/loadout list          # see everything available (or --installed)
npx github:naffis/loadout add ship-a-feature planning-a-change no-any
npx github:naffis/loadout update        # merge + install missing starter/uses deps (keeps edits)
npx github:naffis/loadout update --check # dry run; non-zero if content drift or missing deps
npx github:naffis/loadout diff <id>     # upstream vs your local copy
npx github:naffis/loadout doctor        # validate the loadout repo itself
```

Pin with a tag when you care about reproducibility: `npx github:naffis/loadout#<tag> <command>`.

What `add` does per type: skills → `.cursor/skills/<id>/`; rules → `.cursor/rules/<id>.mdc`
**and** projected into `CLAUDE.md`; commands → `.cursor/commands/<id>.md` + `.claude/commands/<id>.md`;
agents → `.cursor/agents/<id>.md` + `.claude/agents/<id>.md`; MCP → merged into
`.mcp.json`/`.cursor/mcp.json`; docs/workflows → copied preserving their path. Everything
vendored is tracked in `loadout.lock.json`, so `update` can three-way merge without clobbering
local edits (a true conflict gets markers, never silent data loss). `update` also installs
anything still missing from `kits.starter` and from each installed workflow's `uses:` block
(`--refresh-only` skips that backfill; `--check` reports missing deps as drift).

---

## 4. How the pieces work together

Composition is explicit. Every asset declares (in `registry.json`, and in each skill's
`## Pairs with` section) what it pairs with and which **workflows** it serves. A workflow
(`processes/workflows/<name>.md`) is a named recipe that sequences rules, skills, commands,
and subagents, with optional `gate` (objective check), `stop_condition`, and `state` fields.

**Worked example — `ship-a-feature`:**

1. **Rules in the background** color everything: `no-shortcuts`, `size-limits`, `testing-conventions`, `commit-and-pr-conventions`, `regression-test`.
2. **`planning-a-change`** (skill) — explore, write and stress-test a short plan.
3. Implement, adding tests for new behavior.
4. **`review-build`** (`/review-build`) — evidence-first check of the diff vs the plan (prefer a fresh chat when stakes are high).
5. **`reviewer`** (subagent) checks the diff against the plan in a fresh context — maker ≠ checker.
6. **`writing-commit-messages`** → **`opening-a-pr`** (skills); **`making-a-pr-reviewable`** if the diff is noisy.
7. The `gate` (your test+lint command) must pass before "done."

For high-stakes work, use **`plan-then-build`** instead: `/plan` → `/review-plan` →
implement → `/review-build`.

Other shipped workflows: `plan-then-build` (`/plan` → `/review-plan` → implement →
`/review-build`), `fix-ci-until-green`, `debug-production`,
`security-pass`, `clear-the-queue`, `safe-refactor`, `ship-a-migration`, `dependency-bump`,
`cut-a-release`, `onboard-to-codebase`, `run-autonomous-loop`, `run-quality-loop`.

**Routing within a workflow** follows the golden rule: the constraints are rules loaded
automatically, the steps are skills, enforcement is a hook, and a separate subagent verifies.
The quality loop is a good mini-example: `reviewing-code-quality` (find issues) →
`refactoring-code` (fix them safely) under the `size-limits` + `refactor-discipline` rules.

**Running work as a verified loop.** For non-trivial or long-horizon work, the `agentic-loop`
skill (and its `agentic-loop.mdc` rule) is the execution discipline _inside_ any
workflow/phase: write a stop-condition contract, verify against ground truth, keep a checker
separate from the maker, manage the context budget, and stay git-safe. `running-a-dev-cycle`
is the adaptive router that classifies a task and walks it through the right phases (each run
as an agentic loop); `root-cause-fix` is the prove-cause-then-class-fix engine for defects; and
`orchestrating-parallel-agents` fans independent work out across worktrees (default) or a
shared trunk when `shared-working-tree` / `committing-on-shared-trunk` are installed, with a
serialized, maker-checker-gated landing. For **one** nontrivial task that might split into
verified units, `task-topology` chooses single-loop (default), pipeline, or graph; `decompose`
writes shared contracts; `implement-node` workers stay inside file allowlists; `integrate`
fans in with a full-suite gate — composed as `build-as-graph`. That path is not the same as
clearing a ticket queue. The `run-autonomous-loop` workflow composes the loop primitives for
unattended, until-contract-met runs — gated by `loop-preflight`. See
[`agentic-patterns.md`](./agentic-patterns.md) for the patterns behind them.

---

## 5. Build a feature, end to end

A worked, copy-paste path for landing a non-trivial change with the `ship-a-feature`
workflow.

**Equip the project once.** Adding a workflow doesn't pull in its parts. Prefer the
agent contract starter in [`INSTALL.md`](../INSTALL.md) (Flow A step 4) — it vendors
`ship-a-feature` plus its full `uses:` block, routing (`start` / `getting-started`),
`equipping-loadout`, and core always-on rules. Or run that `add` list yourself from
`INSTALL.md`.

**High-rigor alternative — `plan-then-build`** (when a shallow plan would leave decisions
to coding time). Use registry rule ids (`*-rule`), not skill names, for the plan/build rules:

```bash
npx github:naffis/loadout add \
  plan-then-build \
  create-plan review-plan review-build agentic-loop \
  writing-tests updating-docs reviewing-and-shipping \
  writing-commit-messages opening-a-pr making-a-pr-reviewable \
  plan review-plan-cmd review-build-cmd \
  create-plan-rule review-plan-rule review-build-rule \
  no-shortcuts size-limits testing-conventions test-coverage \
  regression-test documentation-updates definition-of-done \
  commit-and-pr-conventions
```

If you use Cursor **Remote Rules**, all rules auto-sync — drop the rule ids and just add the
workflow + skills.

**Invoke it.** You don't call each asset by hand: rules load automatically, and naming the
workflow makes the agent walk its steps. In Cursor (Agent) or Claude Code, paste:

> Follow the `ship-a-feature` workflow to build `<your feature>`.
> Gate: `<your test + lint command>`.
> Done when: tests + lint pass, `/review-build` PASS, a reviewer pass finds no
> correctness/intent gaps, PR opened.

Unsure which workflow fits, or starting cold? Run **`/start`** (or _"I want to build X —
what should I do?"_) and `getting-started` routes you and hands back a kickoff prompt.

**What runs, in order:**

1. **Plan** — `planning-a-change` explores the code and writes a stress-tested plan.
2. **Implement** — smallest safe change first, under the background rules (`no-shortcuts`, `size-limits`, …).
3. **Test** — `writing-tests`; bug fixes get a failing-then-passing test (`regression-test`).
4. **Verify** — run the `gate` (your test + lint command) and show the evidence.
5. **Docs** — `updating-docs` in the same change.
6. **Review the build** — `review-build` (`/review-build`): diff vs plan, shortcut sweep, pasted gate output (prefer a fresh chat when stakes are high).
7. **Review (maker ≠ checker)** — dispatch the `reviewer` on the diff vs the plan (_"use the reviewer subagent on this diff"_). In Cursor this is a separate review pass; in Claude Code it's the `reviewer` agent.
8. **Commit & PR** — `writing-commit-messages` → `opening-a-pr` (`making-a-pr-reviewable` first if the diff is noisy).

Set the `gate` to your real command so step 4 is objective. The workflow records progress in
its `state` file, so a resumed run continues cleanly. Other workflows follow the same
pattern: `fix-ci-until-green`, `plan-then-build`, `debug-production`, `cut-a-release`,
`onboard-to-codebase`, and the rest in [`catalog.md`](./catalog.md).

---

## 6. Authoring and keeping it sharp (self-improving)

loadout is meant to compound — every mistake becomes a permanent guard ("the ratchet").

- **`hardening-the-harness`** (skill) — the ratchet itself: take a real failure and encode a guard in the _right_ layer (an `AGENTS.md` line, a rule, a hook, a subagent check, or a skill).
- **`rule-author`** / **`skill-author`** (skills) — scaffold a new rule/skill to loadout's conventions and apply the rule-vs-skill test. `skill-author` enforces the frontmatter contract (gerund name, third-person description, body <500 lines, references one level deep) that `doctor` checks.
- **`learning-from-chats`** (skill) — mine recurring preferences from chats into rules/skills/`AGENTS.md`.
- **Progression:** brand-new repos start with [`bootstrap-project`](../processes/runbooks/bootstrap-project.md); then [`harness-setup`](../processes/runbooks/harness-setup.md) walks the default → self-improving rungs; [`loop-preflight`](../processes/runbooks/loop-preflight.md) gates before you automate anything. Active outages use [`hotfix-and-rollback`](../processes/runbooks/hotfix-and-rollback.md).

After authoring, add a `registry.json` entry and run `loadout doctor` (it validates
frontmatter, composition references, orphaned files, and lockfile integrity). CI runs
`doctor` on every push.

---

## 7. See also

- [`catalog.md`](./catalog.md) — one-line reference for every skill, rule, agent, command, workflow, runbook, and template.
- [`external-practices.md`](./external-practices.md) — the Anthropic/Cursor conventions behind the assets.
- [`agentic-patterns.md`](./agentic-patterns.md) — the 2026 agentic-coding pattern catalog (the loop, context engineering, maker-checker, tool design, root-cause) mapped to the assets that encode each.
- [`agent-harness-engineering.md`](./agent-harness-engineering.md) and [`loop-engineering.md`](./loop-engineering.md) — the methodologies loadout is built on.
