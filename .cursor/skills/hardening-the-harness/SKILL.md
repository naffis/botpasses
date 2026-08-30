---
name: hardening-the-harness
description: Turn a real agent failure into a permanent guard in the right harness layer (AGENTS.md line, rule, hook, subagent check, or skill). Use when the agent made a mistake you don't want to see again — "the ratchet."
---

# Hardening the harness

## Trigger

The agent did something wrong — shipped broken/“finished” code, ran a destructive command, ignored a convention, derailed on a long task — and you want it to never happen again. Don't just retry; ratchet it.

## Workflow

1. **Name the failure precisely.** What did the agent do, and what should it have done? One sentence each. A vague failure can't be guarded.
2. **Pick the right layer** (encode the fix where it actually binds):
   - Missing convention / standing knowledge → a line in `AGENTS.md`, or a scoped `.mdc` rule (use `rule-author`).
   - Must-happen-every-time enforcement (block destructive cmd, run typecheck/lint after edit, approval before push) → a **hook** (see the `harness-hooks` runbook). Promote a rule to a hook if the agent keeps violating it.
   - A long/complex task that derailed → a planning step or a planner/executor split (`planning-a-change`).
   - "Finished" broken code → a verification gate (test/typecheck) wired into the loop, and/or a `reviewer` subagent check.
   - A review category the checker missed → add it to the `reviewer` / `security-reviewer` agent.
   - A repeatable procedure done ad hoc → a **skill** (use `skill-author`).
3. **Write the guard** in that layer. Keep it minimal and specific to the observed failure.
4. **Trace it:** the new rule/hook/check should map to this exact failure. If you can't justify it from a real mistake, don't add it.
5. **Prune as you go:** if an old guard exists only for a mistake a current model no longer makes, remove it. Harnesses move, not just grow.

## Guardrails

- Add constraints from observed failures, not speculation — every line earns its place (`AGENTS.md`/rules stay short or they get ignored).
- Don't fix one failure by bloating an always-on rule; put enforcement in a hook, knowledge in memory, procedure in a skill.

## Pairs with

- skills: `rule-author`, `skill-author`, `learning-from-chats`
- runbooks: `harness-setup`, `harness-hooks`
- docs: `agent-harness-engineering`
