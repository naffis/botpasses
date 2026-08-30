---
name: summarizing-my-work
description: Summarize authored commits over a time period into a concise status update. Use for an ad-hoc "what did I get done" / standup note over an arbitrary window; for a structured weekly recap split by category, use weekly-review instead.
---

# Summarizing my work

## Trigger

A request for a status update or "what did I ship" over a window.

## Workflow

1. **Collect** authored commits in the window:

```bash
git log --author="$(git config user.email)" --since="<date>" --pretty="%h %s" --no-merges
```

2. **Group** by theme: features, fixes, refactors/tech-debt, docs/infra. Merge related commits into one line.
3. **Write outcome-first** lines: what now works or is better, not commit hashes. Apply `copy-voice` (plain, no filler).
4. **Lead with impact**; keep it scannable. Note anything blocked or in-flight.

## Guardrails

- Summarize outcomes, not activity. "Fixed N bugs" beats a commit dump.
- Don't include private/customer details in a shareable update.

## Pairs with

- skills: `weekly-review`
- rules: `copy-voice`
