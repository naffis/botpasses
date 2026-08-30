---
name: reviewing-dependencies
description: Audit outdated dependencies and review upgrade PRs for breaking changes. Use for dependency reports or when reviewing a version-bump PR.
---

# Reviewing dependencies

## Trigger

A scheduled dependency report, or a PR that bumps versions.

## Workflow

**Audit (report):**
1. List outdated deps (`pnpm outdated`, `bundle outdated`, etc.).
2. Tier by risk: patch (low) / minor (medium) / major (high), and flag anything with known advisories.
3. Recommend an order: security fixes first, then low-risk batches, majors individually.

**Review a bump PR:**
1. For each non-patch bump, read the changelog/release notes between versions for breaking changes and deprecations.
2. Check call sites in this repo against the changes.
3. Verify the lockfile was regenerated (not hand-edited) and CI passes.
4. Run the affected tests; for majors, exercise the touched paths manually.

## Guardrails

- Don't blanket-approve a major bump because tests pass; read the breaking-change notes.
- Split a large multi-package bump if any single package is high-risk.

## Pairs with

- rules: `lockfile-conflicts`, `dependency-version-management`
- skills: `reviewing-and-shipping`, `researching-a-dependency`
- workflows: `dependency-bump`
