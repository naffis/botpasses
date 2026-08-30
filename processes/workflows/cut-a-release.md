---
name: cut-a-release
uses:
  rules: [documentation-updates, db-migration-safety]
  skills: [assessing-release-readiness, reviewing-and-shipping]
  commands: [changelog]
gate: "release-readiness verdict is GO"
stop_condition: "release tagged and notes published"
state: ".loadout/state/release.md"
---

# Cut a release

If this release includes a schema/data migration that is not already expand-safe and
tested, finish it via `ship-a-migration` first — do not discover expand/contract mid-promote.

1. **Readiness** — `assessing-release-readiness`: scope, gates, risk surface, rollback plan → GO / GO-WITH-CONDITIONS / NO-GO.
2. **Changelog** — run the `changelog` command to draft release notes from merged work; apply `copy-voice`.
3. **Promote** — follow `multi-plane-deploy` (runbook) for the deploy order; tag the release.
4. **Verify** post-deploy on the affected paths; keep the rollback ready.

Hand-off: readiness gates the release; changelog documents it; the deploy runbook executes it in the right order.
