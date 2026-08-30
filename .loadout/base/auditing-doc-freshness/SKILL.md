---
name: auditing-doc-freshness
description: Sweep docs for drift — dead links, renamed symbols, outdated commands/examples, and duplicated content that no longer matches the code — and fix or flag each. Use periodically, before a release, or after a big refactor.
---

# Auditing doc freshness

## Trigger

Docs may have drifted from the code — before a release, after a rename/refactor, or on a periodic sweep.

## Workflow

1. **Inventory the doc surfaces:** `README*`, `docs/`, package READMEs, ADRs, runbooks, and doc comments on the public API.
2. **Check links.** Run a link checker (or grep for `](` and verify targets); fix or remove dead internal and external links.
3. **Check references to code.** For symbols/paths/flags/endpoints named in docs, confirm they still exist (grep the codebase). Renamed or deleted → update or remove the mention.
4. **Check commands & examples.** Run the documented quick-start/commands and code snippets; fix anything that errors or produces different output. Flag examples that can't be run.
5. **Check for drifted duplication.** Where docs paste content that lives canonically elsewhere (config, code, another doc), reconcile and replace with a link.
6. **Check the changelog/ADRs** cover notable recent changes; backfill conspicuous gaps.
7. **Report & fix:** apply the safe fixes; for anything ambiguous, list it with the file:line and the suspected staleness for a human to decide.

## Guardrails

- Prefer deleting a wrong doc over leaving it; a confidently-wrong doc is worse than a missing one.
- Don't rewrite accurate docs for style — that's `copy-voice`/editing, not a freshness fix.
- This is a backstop; the real fix is updating docs in the same change (`documentation-updates`).

## Pairs with

- rules: `documentation-updates`, `docstrings-current`
- skills: `updating-docs`
