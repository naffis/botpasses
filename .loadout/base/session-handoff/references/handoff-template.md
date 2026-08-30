# Handoff template

```markdown
---
status: open
created: YYYY-MM-DDTHH:mmZ
slug: short-kebab-name
plan: path/to/plan.md # or "none"
---

# Handoff: <short name>

## Goal / done-condition

- Outcome: …
- Done when: <verifiable — command, AC, or binary check>

## Accomplished

| Item | Where         | Evidence              |
| ---- | ------------- | --------------------- |
| …    | `path:symbol` | test / command / read |

## In progress

- Current unit: …
- Files touched (WIP): …

## Open gaps

| Item | Status                     | Notes |
| ---- | -------------------------- | ----- |
| …    | Partial / Missing / Punted | …     |
| —    | none                       |       |

## Failed attempts (do not repeat blindly)

| Attempt | Error / outcome | Lesson |
| ------- | --------------- | ------ |
| …       | …               | …      |

## Decisions locked

- … (pointer to plan ADR / DECISIONS.md)
- Do not reopen unless new evidence: …

## Verification

| Command             | Outcome     |
| ------------------- | ----------- |
| `<project typecheck>` | … / not run |

## Next step (exact first action)

1. …

## Constraints

- Branch: … (stay on current; no new branch unless user asks)
- Do not commit/push/PR unless user asks
- Survivors / blockers needing human: …
```
