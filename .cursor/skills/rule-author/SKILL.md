---
name: rule-author
description: Scaffold a new .mdc Cursor rule with correct type and frontmatter, and check whether it should be a skill instead. Use when adding or restructuring a rule.
---

# Rule author

## Trigger

Capturing a persistent constraint or convention as a rule.

## Is it actually a rule?

A rule is a standing constraint that should color behavior with no steps to run ("never alter a column type in place"). If it's a procedure with a beginning and end, use `skill-author` instead. If it's genuinely cross-tool baseline behavior (stack, voice, naming), put it in `AGENTS.md`, not an `.mdc`.

## Choose the type (frontmatter)

| Want | `alwaysApply` | `description` | `globs` |
|---|---|---|---|
| Always on (use sparingly) | `true` | — | — |
| Auto-attach on matching files | `false` | — | `["glob"]` |
| Agent pulls in when relevant | `false` | required, specific | omitted |
| Manual via `@mention` | `false` | omitted | omitted |

`description` is required for agent-requested rules and drives selection — make it specific.

## Body conventions

- Keep it under 500 lines; split large rules into composable ones.
- Reference canonical files (`@path`) instead of pasting code that will go stale.
- Write like a clear internal doc: focused, actionable, concrete examples.
- Don't: dump a whole style guide (use a linter), document common tools the agent knows, or add edge cases that rarely apply. Add a rule only when the agent repeats a mistake.

## Workflow

1. Confirm it's a rule (not a skill / AGENTS.md line). 2. Pick the type. 3. Write tight frontmatter + body. 4. Add a `cursor-rule` entry to `registry.json`. 5. Run `loadout doctor`.

## Pairs with

- skills: `skill-author`, `learning-from-chats`
- docs: `external-practices`
