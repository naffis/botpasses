# Harness setup: from default to self-improving

`coding agent = model + harness`. Most builders run on the **default** harness — no rules,
no subagents, no hooks, no memory — and blame the model when it slips. The leverage is in
the harness. This runbook is the progression and the two habits that make it compound. See
`docs/agent-harness-engineering.md` for the full methodology.

## Work backwards from behaviour

Each harness piece exists to deliver a behaviour the model can't do on its own. **If you
can't name the behaviour a component delivers, cut it.** (Same idea as "compose, don't
pile" — every asset earns its context cost.)

## The progression

Add rungs as you hit their failure modes; don't bulk-install everything on day one.
For a brand-new repo, start with the `bootstrap-project` runbook (init + baselines +
starter kit), then climb these rungs.

1. **Memory** — an `AGENTS.md` (and `CLAUDE.md` for Claude Code) that loads every session.
   Start from `templates/AGENTS.md`. Keep it short — a pilot's checklist, not a style guide.
2. **Rules** — scoped `.cursor/rules/*.mdc` for constraints that should color behaviour on
   matching files. `loadout add <rule>`; author new ones with the `rule-author` skill.
3. **Skills** — invokable procedures with progressive disclosure (lean body, detail in
   references). `loadout add <skill>`; author with `skill-author`.
4. **MCP / tools** — connect the real world. Few focused tools beat many overlapping ones.
   Treat tool descriptions as trusted prompt text — audit any external MCP first
   (`audit-external-skills`). Start from `templates/mcp.json`.
5. **Hooks** — the enforcement layer for must-happen-every-time behaviour. See
   `harness-hooks.md` (format-on-write, post-edit checks, block-destructive, approval gates).
6. **Subagents** — split the maker from the checker. Use `reviewer` / `security-reviewer`
   for verification and `explorer` for read-only investigation that keeps main context clean.
7. **Planning + verification** — decompose to a plan file and write the done-condition
   first (`planning-a-change`, `ship-a-feature`). Self-verify each step.
8. **Loops** — only after a manual run is reliable (`loop-preflight`). Continuation against
   a goal with state on disk (`templates/automation-loop.md`, `templates/STATE.md`).
9. **Self-improving** — a loop plus memory that compounds: every run leaves the next sharper.
   In practice that's the ratchet below, plus the meta layer (`hardening-the-harness`,
   `learning-from-chats`, `skill-author`, `rule-author`).

## The ratchet (the load-bearing habit)

Treat every agent mistake as a permanent signal, not a one-off:

1. The agent makes a mistake.
2. Encode a guard so it can't happen again, in the **right layer**:
   - a missing convention → an `AGENTS.md` line or a rule
   - a destructive command → a blocking hook
   - a long task that derailed → a planner/executor split
   - "finished" broken code → a typecheck/test gate (hook) in the loop
   - a missed review category → add it to the `reviewer` subagent
3. Every rule/hook/check should trace back to a specific failure. Add constraints from
   observed mistakes; **remove** them when a better model makes them redundant (harnesses
   move, they don't only grow).

Use the `hardening-the-harness` skill to run this loop on a concrete failure.

## Maintenance

- Version assets; let `loadout doctor` flag drift and stale bumps.
- Prune dead scaffolding when the model no longer needs it — a component that loads but
  rarely helps is a context tax.
- Pin consumers to release tags; review the diff on `loadout update`.
