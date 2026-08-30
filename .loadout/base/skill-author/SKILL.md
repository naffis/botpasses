---
name: skill-author
description: Scaffold a new SKILL.md to loadout conventions and apply the rule-vs-skill test. Use when creating or restructuring a skill.
---

# Skill author

## Trigger

Creating a new skill, or an artifact that might be a skill.

## Decision test first

A **skill** is a procedure you invoke to accomplish something, with a beginning and end. A **rule** is a persistent constraint with no steps to run. If it's a pure constraint, use `rule-author` instead. If it's both, split: constraint → rule, procedure → skill (a procedure-scoped "Never do" block may stay in the skill).

## Frontmatter contract (enforced by `loadout doctor`)

- `name`: gerund where natural (`processing-pdfs`), lowercase + hyphens, ≤64 chars, no `claude`/`anthropic`. Avoid `helper`/`utils`/`tools`.
- `description`: third person, ≤1024 chars, states **what it does AND when to use it** with trigger terms (this drives auto-selection). Not "I can…"/"You can…".

## Body conventions

- Target **150–250 lines**. Hard cap 500. Newer models skim long bodies.
- Progressive disclosure: metadata always loaded → body on trigger → `references/` and `scripts/` on demand. References **one hop** from `SKILL.md`.
- **Scripts for fragile mechanical steps** (Cursor 2026 + Anthropic): a grep/receipt the agent can fake in prose must be a script the report quotes.
- Optional Cursor fields: `paths` (file globs), `disable-model-invocation` (slash-only).
- House structure: `## Trigger`, `## Workflow` (numbered), `## Suggested Checks`, optional `## Guardrails` / `## Never do`, `## Pairs with`.
- Isolated verification: if the skill claims done, name a **readonly checker** (`flight-checker`, `reviewer`, `/review`) — never a same-context self-grade. See `docs/external-practices.md` § 2026 Cursor.

## Workflow

1. Run the decision test. 2. Draft frontmatter. 3. Write a tight body in the house structure. 4. Add `## Pairs with`. 5. Add a `registry.json` entry (`layer`, `pairs_with`, `workflows`) and run `loadout doctor`.

## Pairs with

- skills: `rule-author`, `learning-from-chats`, `deep-flight`, `post-flight`, `do-it-right`
- docs: `external-practices`, `loop-engineering`
