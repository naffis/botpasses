---
name: writing-an-adr
description: Record an architecture decision as a short ADR (context, decision, consequences, alternatives). Use when making a significant or hard-to-reverse technical choice.
---

# Writing an ADR

## Trigger

A decision that's significant, hard to reverse, or that future readers will ask "why did we do it this way?" about — a datastore choice, an API contract, an auth model, a build/deploy approach.

## Workflow

1. **One decision per ADR.** Put it in `docs/adr/` (or the repo's ADR location) as `NNNN-short-title.md`, numbered sequentially. Never edit a decided ADR's meaning — supersede it with a new one that links back.
2. **Write it short** using this structure:

```markdown
# NNNN. <decision title>

- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD

## Context
What forces are at play — the problem, constraints, and what we know. No solution yet.

## Decision
The choice, stated plainly in active voice: "We will ...".

## Consequences
What becomes easier and what becomes harder. Trade-offs, follow-ups, and what we're now committed to.

## Alternatives considered
Each option and why it lost (briefly).
```

3. **Link it** from the code/doc it governs, and reference the ADR in the PR that implements the decision.
4. **Keep the log honest:** when a later decision overrides this one, set Status to `superseded by NNNN` rather than deleting it.

## Guardrails

- ADRs capture decisions, not designs — keep them to a page; link to a design doc if one exists.
- Don't retro-write ADRs for trivial or easily-reversible choices.

## Pairs with

- rules: `documentation-updates`
- skills: `updating-docs`, `planning-a-change`, `create-plan`
- workflows: `plan-then-build`
