# Methodology: Agent Harness Engineering

> A 14-step roadmap from one agent to a self-improving system. The framing: *"Everyone's
> talking about loops. Almost no one is talking about what the loop runs on. 9 out of 10
> builders run Claude Code on the default harness — no rules, no subagents, no hooks, no
> memory."*
>
> **This is the most loadout-relevant methodology: loadout is a distribution system for
> harness components.** Integration is almost entirely additive/reinforcing — no spec
> conflicts. New assets added are listed in §4.

---

## 1. The core idea

**`coding agent = model + harness`.** If you're not the model, you're the harness: the
prompts, rules, tools, skills, MCP servers, sandboxes, hooks, subagents, memory, feedback
loops, and recovery paths wrapped around the model so it can finish real work.

- **A decent model with a great harness beats a great model with a bad harness.** On
  Terminal Bench, the *same* model moved from Top 30 to Top 5 by changing only the harness.
  The gap between what models can do and what you see them do is largely a harness gap.
- **The "skill issue" reframe:** when the agent does something dumb, it's usually a
  configuration problem, not a model problem. The fix is legible — add a rule, a hook, a
  subagent, a tool — not "wait for the next model."
- **Where loops fit:** loop engineering (see `docs/loop-engineering.md`) is
  about *running* the agent on a cadence. Harness engineering is about *what the loop runs
  on*. A loop on a bad harness just makes mistakes faster.

## 2. The harness components (work backwards from the behaviour you want)

Each component exists to deliver a behaviour the model can't do alone. **If you can't name
the behaviour a component delivers, it shouldn't be there.**

| Behaviour needed | Harness piece | loadout layer |
|---|---|---|
| Durable state, coordination, rollback | filesystem + git | (host) |
| General-purpose action | bash + code execution | (host) |
| Safe execution, parallelism, good defaults | sandbox + default tooling | (host) |
| Standing project knowledge, continual learning | `AGENTS.md`/`CLAUDE.md` memory, rules | **baseline / rule** |
| Knowledge past the training cutoff | web search + MCP (e.g. Context7) | **mcp** |
| Performance over long context | compaction, tool-output offloading, **skills w/ progressive disclosure** | **skill** |
| Maker ≠ checker | planner / generator / evaluator **subagents** | **agent** |
| Long-horizon autonomy | planning files, verification, loops | **workflow / skill** |
| Must-happen-every-time enforcement | **hooks** | **hook** |
| Know when it's failing | observability (logs, traces, cost) | (rules: observability-first) |

## 3. The roadmap: default harness → self-improving system

The arc runs from one agent to a self-improving system. loadout ships the assets for each rung:

1. **Default harness** (most people stop here): raw Claude Code/Cursor, no config.
2. **Memory** — an `AGENTS.md`/`CLAUDE.md` that loads every session. *(loadout: `template-agents-md`, `template-claude-md`.)*
3. **Rules** — scoped constraints, kept short, each earning its place. *(loadout: 19 `.mdc` rules + `rule-author`.)*
4. **Skills** — invokable procedures with progressive disclosure. *(loadout: skills + `skill-author`.)*
5. **MCP / tools** — connect the real world; few focused tools beat many overlapping ones; tool descriptions are trusted prompt text (injection risk). *(loadout: `template-mcp`, `audit-external-skills`.)*
6. **Hooks** — the enforcement layer. *(loadout: `harness-hooks` runbook + the SessionStart notify hook.)*
7. **Subagents** — generator/evaluator split; verifiers beat self-grading. *(loadout: `reviewer`, `security-reviewer`, `explorer`, `ci-watcher`.)*
8. **Planning + verification** — decompose to a plan file; self-verify each step; write the done-condition first. *(loadout: `planning-a-change`, `ship-a-feature`.)*
9. **Loops** — Ralph-style continuation against a goal, state on disk. *(loadout: `loop-preflight`, `template-automation-loop`.)*
10. **Self-improving** — *a loop plus memory that compounds: every run leaves the next run sharper.* The practical version is **the ratchet** (§3.1 below) plus the meta layer. *(loadout: `hardening-the-harness`, `learning-from-chats`, `skill-author`, `rule-author`.)*

### 3.1 The ratchet (the load-bearing habit)

> Anytime the agent makes a mistake, engineer a solution so it never makes that mistake
> again. **Every line in a good `AGENTS.md` should trace back to a specific thing that went
> wrong.** Add constraints only from observed failures; remove them when a better model
> makes them redundant.

A single failure ratchets into the *right layer*: a convention → `AGENTS.md` line; a
destructive command → a blocking hook; a 40-step task that derailed → a planner/executor
split; "finished" broken code → a typecheck back-pressure signal in the loop. This is why a
harness is a discipline, not a framework — it's shaped by *your* failure history, so you
can't download it (but you can download the well-factored pieces, which is what loadout is).

### 3.2 Hooks: enforcement, not advice

Hooks separate "I told the agent to do X" from "the system enforces X." Run at lifecycle
points (after edit, before commit, on session start). The principle: **success is silent,
failures are verbose** — a passing check says nothing; a failing one injects the error back
into the loop and the agent self-corrects. Use a hook (not a rule) when something must
happen every time with zero exceptions: block destructive bash, run typecheck/lint/test
after edits, auto-format on write, require approval before push/PR.

### 3.3 Context engineering

Harnesses are largely delivery mechanisms for good context (context rot is real). Key
techniques: **compaction** (summarize/offload as the window fills), **tool-output
offloading** (keep head/tail, write the full 2,000-line log to disk), **progressive
disclosure** (skills reveal detail only when needed), and **full context resets** with a
structured hand-off brief for very long jobs (Anthropic: compaction alone wasn't enough).
loadout's `STATE.md` template is the hand-off brief.

### 3.4 Harnesses don't shrink, they move

Every harness component encodes an assumption about what the model can't do yet. When the
model gets better at that, the component becomes dead code and should come out; when the
model unlocks a new ceiling, new scaffolding is needed to reach it. So loadout assets carry
versions and `doctor` flags drift — the library is meant to be pruned, not just grown.

## 4. What was added to loadout (change list — all additive, no conflicts)

| # | Change | Where | Status |
|---|---|---|---|
| 1 | `harness-hooks` runbook — the enforcement layer with ready-to-paste `hooks.json` + scripts (format-on-write, post-edit checks, block-destructive, pre-push approval). Closes loadout's biggest harness gap (it had only the SessionStart notify hook). | `processes/runbooks/harness-hooks.md` | **done** |
| 2 | `harness-setup` runbook — the default→self-improving progression, the ratchet, and "work backwards from behaviour." | `processes/runbooks/harness-setup.md` | **done** |
| 3 | `hardening-the-harness` skill — invokable procedure: take a real failure and ratchet it into the right layer (AGENTS.md line / rule / hook / subagent / skill). | `plugins/meta/skills/hardening-the-harness` | **done** |
| 4 | Guardrails folded into loadout: the ratchet, hooks-as-enforcement, and "name the behaviour or cut it." | rules / runbooks | **done** |

Everything else in the methodology loadout already had (rules + `rule-author`, skills +
`skill-author`, subagents, MCP + `audit-external-skills`, planning/verification workflows,
loops + `loop-preflight`/`automation-loop`, memory templates, `learning-from-chats`). This
pass made the harness layer explicit and closed the hooks gap.
