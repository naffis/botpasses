---
name: simplifying-code
description: >
  Simplify recently changed code for clarity and YAGNI while preserving
  behavior — Anthropic-style /simplify pass on the branch or session diff.
  Collapse one-use helpers, flatten nesting, reuse in-tree utils, delete proven
  dead branches; no redesign and no drive-by features. Use when the user says
  "simplify", "simplify this", "simplify the diff", "reduce complexity",
  "YAGNI pass", "make this clearer", "/simplify", or after a large
  agent-written change before review-build. Anti-triggers: AI-slop style
  cleanup only → deslopping; planned structural move/extract →
  refactoring-code; maintainability audit without edits → reviewing-code-quality.
---

# Simplify code

Modern models over-build. This skill is a **behavior-preserving clarity pass**
on the current diff (or named files): fewer branches, less indirection, match
local patterns — not a redesign and not a drive-by feature.

Distinct from `deslopping` (narrating comments, `any` casts, AI tells) and
`refactoring-code` (planned structural moves behind a test net).

## Trigger

After implementation, before `review-build` / PR, or when the user asks to
simplify a hot path.

## Workflow

### 1. Scope the blast radius

```bash
# <base> = origin/dev, origin/main, or the user's named base
git diff <base>...HEAD --stat
git diff <base>...HEAD
git diff   # include unstaged session work
```

Default scope: **this branch/session diff** (committed since base **plus**
unstaged). Do not simplify unrelated files. If the user named paths, stay
inside them.

### 2. Confirm a safety net

- Prefer existing tests covering the touched behavior.
- If none exist and the logic is non-trivial, add a thin characterization test
  **before** simplifying (`refactor-test-net-required` spirit).
- Run the affected package tests; paste outcome.

### 3. Simplify (preserve behavior)

Apply only changes that keep external behavior identical:

| Do                                   | Don't                                       |
| ------------------------------------ | ------------------------------------------- |
| Collapse needless helpers used once  | Invent new abstractions "for later"         |
| Flatten nesting with early returns   | Change control flow semantics               |
| Inline obvious indirection           | Rename widely for taste                     |
| Reuse existing utils already in-tree | New shared packages / frameworks            |
| Delete dead branches proven unused   | Remove code "probably unused" without proof |
| Match surrounding file style         | Reformat whole files for style alone        |

Also strip anything `deslopping` would catch if you see it in-scope.

### 4. Verify

```bash
# project gate for touched packages, e.g.
npm test -- <file-or-name>
# + typecheck/lint for touched packages
```

Paste output. If behavior must change to "simplify", **stop** — that is a
feature/fix; use the normal plan/fix path instead.

### 5. Report

Short list: what got simpler (files), what was left alone (and why), gates run.

## Guardrails

- Behavior identical unless fixing a clear bug (+ regression test).
- Respect file/function size limits — extract only when simplifying requires it,
  and keep extraction mechanical.
- No scope expansion, no drive-by refactors outside the diff.
- Leave edits unstaged unless asked to commit.

## Never do

- "Simplify" by deleting error handling or failing open
- Replace a correct pattern with a clever one-liner that obscures intent
- Touch unrelated modules to "clean up" without a failing test that
  defines the behavior

## Pairs with

- skills: `deslopping`, `refactoring-code`, `review-build`, `reviewing-code-quality`,
  `writing-tests`
- rules: `no-shortcuts`, `refactor-discipline`, `size-limits`
- commands: `simplify` (`/simplify`) — registry id `simplify-cmd`
