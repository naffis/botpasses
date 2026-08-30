---
name: updating-docs
description: Find and update every doc surface affected by a code change — README, API reference, docstrings, config/setup docs, runbooks, ADRs, changelog — in the same change. Use whenever a change alters behavior, an API, config, or a procedure.
---

# Updating docs

## Trigger

You changed behavior, a public API/signature, config/env/flags, a CLI, or an operational procedure. Docs ship with the code, not after.

## Workflow

1. **Classify the change** and map it to doc surfaces (skip any that don't apply):
   - behavior / how to use it → README or how-to guide
   - public API / signature / errors → API reference **and** in-code docstrings/JSDoc (see `docstrings-current`)
   - config, env vars, CLI flags → setup/config doc + example `.env`/config
   - operational procedure → the relevant runbook
   - a significant or hard-to-reverse decision → an ADR (use `writing-an-adr`)
   - anything users or operators would notice → a changelog entry
2. **Find the surfaces.** Grep the repo for the old name/flag/endpoint and for references to the thing you changed; check `docs/`, `README*`, package READMEs, and doc comments. Don't trust memory for where it's documented.
3. **Update in the same change.** Edit each surface to match the new behavior. Reference the canonical source instead of duplicating; link, don't paste.
4. **Update examples.** Fix commands/snippets so they still run; remove examples for removed behavior.
5. **Delete stale docs** for anything you removed — a wrong doc is a trap.
6. **Verify.** Re-read the diff's docs as a new reader; check links resolve and examples are correct (run them or a link-checker where available).

## Guardrails

- Don't over-document — only what removing would cause a mistake; no narrating the obvious.
- Don't open a separate "docs later" ticket for docs that belong with this change.

## Pairs with

- rules: `documentation-updates`, `docstrings-current`, `copy-voice`
- skills: `writing-an-adr`, `auditing-doc-freshness`, `reviewing-and-shipping`
- workflows: `ship-a-feature`, `plan-then-build`, `ship-a-migration`, `safe-refactor`
