# Methodology: Loop Engineering

> Loop engineering is the shift from **prompting an agent turn-by-turn** to **designing
> the system that prompts the agent**. This doc distills the methodology and maps it onto
> loadout's layers.
>
> **Status: extracted, mapped, and resolved.** All four conflicts (see §4) were decided
> and the agreed items have been folded into loadout's conventions and the `doctor`
> validator.

---

## 1. What the methodology actually is

"Loop engineering" is the shift from **prompting an agent turn-by-turn** to
**designing the system that prompts the agent**: a small loop that finds work, hands
it out, checks the result, records what's done, and decides the next move — on its own.

This is adjacent to, not the same as, loadout. loadout is a *distribution* system for
skills and rules. Loop engineering is about *operating* agents. They intersect hard at
the building blocks (skills, MCP/connectors, sub-agents), so the methodology is most
useful to loadout as (a) opinions about how skills/rules should be shaped and (b) a
candidate body of seed content (workflows, a loops plugin).

The roadmap is 14 steps in three tiers.

### Tier 1 — Do you even need a loop? (steps 1–4)

- **The leverage moved** from prompt quality to system design.
- **4-condition test** — build a loop only if *all four* hold:
  1. **The task repeats** (≥ weekly). One-offs: a manual prompt is cheaper.
  2. **Verification is automated** — an objective gate (tests/typecheck/lint/build) can
     reject bad output with no human in the room.
  3. **Token budget can absorb waste** — loops re-read big contexts and retry; great on
     enterprise budgets, reckless on a metered personal plan.
  4. **The agent has senior tools** — logs, a repro environment, ability to run what it
     wrote.
- **Economics**: loops favor codebases with strong tests, machine-checkable routines,
  and async teams. They hurt solo devs on consumer plans, untested codebases, and teams
  already bottlenecked on human review.
- **30-second per-task check** before delegating: repeats weekly; an instant objective
  reject exists; live env to test; a hard stop (token/timeout/iteration cap); a human
  approval gate before merge/prod. Good first loops: CI-failure triage, dependency
  bumps, lint-and-fix. Bad first loops: architecture, auth/crypto/payments, prod
  deploys, vague "feature" work.

### Tier 2 — The five building blocks (steps 5–9)

| # | Block | Job | loadout layer |
|---|---|---|---|
| 5 | **Automations** | the heartbeat; run on schedule/event; `/loop` (cadence) and `/goal` (run-until-true, checked by a *separate* model) | partial — SessionStart hook, `propagate.yml`; Cursor Automations |
| 6 | **Worktrees** | isolate parallel agents so edits don't collide | not modeled; touches git workflow |
| 7 | **Skills** | codify project knowledge once, read every run; `SKILL.md` + optional scripts/references/assets; **tight boring descriptions beat clever ones** | core |
| 8 | **Connectors / plugins** | MCP to touch the real world (issues, DB, Slack); **plugins ship skills+connectors** | core (`mcp` type, plugins) |
| 9 | **Sub-agents** | split the **maker** from the **checker** (Evaluator–Optimizer); different model/effort per role | maps to the `reviewer` agent |

Plus the recurring sixth thing:

- **State file** (step 10) — persistent memory *outside* the conversation
  (`STATE.md` / Linear / JSON). "The agent forgets, the file remembers." Resumes a loop
  where it left off.

### Tier 3 — Build it right or don't (steps 10–14)

- **Minimum Viable Loop** (step 11): Automation → Skill → State file → Gate. **Execution
  order is law**: get a *manual* run 100% reliable → document it as a *skill* → wrap the
  skill in a *loop* → *only then* schedule it. Skipping straight to scheduling is the #1
  reason loops fail.
- **The "Ralph Wiggum" loop** (step 12): the agent emits a "done" token before the work
  is actually done. You're running one if you lack a real (external) verifier, your
  completion metric is the agent's own judgment, or you lack hard caps. Watch for **goal
  drift** ("do not touch" rules vanish by turn ~47 → force a re-read of the base spec
  every iteration) and **agentic laziness** (→ hard `/goal` checked by a separate model).
- **Comprehension debt & cognitive surrender** (step 13): faster shipping widens the gap
  between what's in the repo and what the team understands; the urge to stop forming an
  opinion. Mitigate: read every diff, periodically break code on purpose to prove gates
  still catch it, keep loops scoped to small machine-checkable changes.
- **The security tax** (step 14): an unattended loop with repo access is a live attack
  surface. Defend against: unreviewed code promotion (require SAST + dependency + secret
  scanning before merge); **skills as injection vectors** (audit external/community
  skills before installing — malicious instructions hide in descriptions); credential
  leaks in verbose logs; permission creep (re-audit token scopes every 30 days).

### Naming / frontmatter / size (what it says, and doesn't)

- **Format**: a skill is a directory with a `SKILL.md` plus optional scripts, references,
  assets — i.e. **progressive disclosure** is the native shape (description/metadata is
  cheap and always considered; the body and references load on demand).
- **Descriptions**: tight and literal, because skills auto-invoke on description match. A
  "clever" description misfires.
- **Size**: no hard number given, but the explicit failure mode is a skill that re-derives
  the whole project every run — keep the always-read part lean, push detail into
  references.
- **Skill vs plugin**: "the skill is the authoring format, a plugin is how you ship it."
- **Skill vs MCP**: skills = codified knowledge; connectors/MCP = the ability to act in the
  real world. Different jobs, both needed.
- **Rules**: the methodology is Codex/Claude-loop centric and has no "rule" concept — but its
  skills embed standing constraints (e.g. a "Never Do" block: *never disable a failing
  test; never touch `src/payments/`*). That co-location is in mild tension with loadout's
  rule-vs-skill split (see Conflict 1).
- **Distribution/sync**: the loop primitives now "ship inside the products" (Codex
  Automations; Claude Code scheduling/hooks/GitHub Actions) rather than bespoke bash. This
  is consistent with loadout's "ride the native rails" principle; no conflict.

---

## 2. Where it agrees with loadout (no action, just confirmation)

- `SKILL.md` is the portable unit; skill = authoring, plugin = shipping.
- Skills and MCP/connectors are *different* layers with different jobs.
- Ride native rails for distribution and automation.
- Keep skills narrow and well-described; an asset that loads but rarely helps is a tax.
  The "tight boring description" principle is the same point.
- Sub-agent maker/checker split = loadout's `reviewer` agent and adversarial review.

---

## 3. Change checklist (folded into loadout)

Status tags: **[done]** folded into loadout / `doctor` now; **[later]** agreed, to be
authored during the harvest.

- **[done] decision test** *(carve-out)* — Procedure-scoped safety rails (a
  `## Never do` / scope block) may live **inside** a skill; only *cross-cutting* constraints
  must become rules/`AGENTS.md`.
- **[done] workflows** *(optional)* — Workflow frontmatter gains optional `gate`,
  `stop_condition`, and `state`, plus a documented **maker→checker hand-off**. `doctor`
  validates shape when present.
- **[done] meta-skills** — `skill-author` enforces progressive disclosure (lean
  `SKILL.md`, detail in `references/`), tight literal descriptions, and an optional
  scope/`Never do` block.
- **[done] inbound trust** — Optional `provenance`
  in `registry.json`; a `doctor` injection-pattern lint (warns) over `SKILL.md`/`.mdc`; a
  consumer security note in the README.
- **[done] runbooks** — The **execution-order law** recorded as a guardrail: manual
  run reliable → document as skill → wrap in loop → schedule last. Never skip to scheduling.
- **[done] seed assets** *(harvest)* — Pre-flight checklists shipped as the `loop-preflight`
  runbook (4-condition test, 30-second loop check, Ralph-Wiggum self-test, security tax). The
  in-task loop discipline shipped as the `agentic-loop` skill (+ `agentic-loop.mdc` rule) with
  references for context engineering, verification/stop-conditions, and subagents/parallelism;
  the adaptive router as `running-a-dev-cycle`; parallel execution as
  `orchestrating-parallel-agents`. For splitting **one** task into verified units (not a
  ticket queue), see `task-topology` / `build-as-graph`. The broader pattern catalog is
  `docs/agentic-patterns.md`.
  No dedicated loop-engineering plugin — all folded into `core-engineering`.
- **[done] templates/** — `STATE.md` and the `automation-loop` starter template shipped.

---

## 4. Conflicts (RESOLVED)

### Conflict 1 — Constraints inside skills vs the rule/skill split
- **loadout default:** if something is both a constraint and a procedure, *split it* — the
  constraint becomes a rule, the procedure a skill.
- **Methodology:** co-locates standing constraints inside the skill (the CI-triage skill's
  `Never Do` block).
- **DECISION (carve-out):** keep the split as default for *cross-cutting* constraints, but
  explicitly allow *procedure-scoped* guardrails to live in the skill. ✅ Folded into loadout.

### Conflict 2 — Scope: should loadout own "loop engineering"?
- **loadout:** distributes skills/rules/docs/workflows; it is not an agent-operations
  framework.
- **Methodology:** is an entire operating model (automations, state, verifiers, MVL).
- **DECISION (harvest):** treat loop-engineering as ordinary harvest/seed content — no
  dedicated plugin, and loadout's CLI does **not** grow loop-runtime responsibilities.
  ✅ Seed content only.

### Conflict 3 — Public marketplace vs "skills as injection vectors"
- **loadout:** the sanitize gate protects *outbound* (no secrets leak out).
- **Methodology:** external skills are an *inbound* attack surface for *consumers*.
- **DECISION (all):** add inbound-trust measures — optional `provenance` in
  `registry.json`, a `doctor` injection-pattern lint (warns), and a consumer security note
  in the README. ✅ Folded into the registry, `doctor`, and README.

### Conflict 4 — Workflow frontmatter: add verification/state primitives?
- **loadout:** workflow frontmatter is `name` + `uses` (rules/skills/commands/agents).
- **Methodology:** a real loop needs an objective gate, a stop condition, persistent state,
  and a maker/checker split.
- **DECISION (optional):** add optional `gate` / `stop_condition` / `state` fields and a
  documented maker→checker hand-off; simple workflows stay simple. `doctor` validates the
  shape when present. ✅ Folded into the workflow schema and the validator.
