# CLAUDE.md

Loaded at the start of every Claude Code session. Kept short on purpose; project knowledge lives in `AGENTS.md`, `README.md`, and `docs/`.

## Git safety (highest priority)

Read-only git is always allowed (`status`, `diff`, `log`, `show`, `branch --list`).
Do not stage, commit, branch, push, stash, discard WIP, or open/merge PRs unless the user
explicitly asks in their message. A request to make a change is not permission to commit it.
Leave edits as unstaged changes. Never `git stash`.

## Project conventions

See @AGENTS.md for stack, commands, architecture, and conventions. Product plan and audit:
`docs/plans/2026-09-04-app-audit-and-improvement-plan.md`.

## Definition of done

A change that adds or alters behavior ships in the same change with tests, lint, and typecheck
green, a changelog entry when users or operators would notice, and a doc update when behavior,
API, config, or a procedure changed. Verify with `npm run lint && npm test && npm run typecheck`
and show the output. Bug fixes carry a regression test that fails before the fix.

## Hard rules

- No `any`, no floating promises, exhaustive `switch` over unions.
- No secret value ever reaches an MCP result, operator JSON, audit row, log line, or email.
- Operator identifiers (Neon slugs, Linear workspace URLs, home paths) stay in `.env.ops`, never in git.
- No em-dashes in user-facing copy. Plain, direct, specific.
- Schema changes are expand-only and land in both `src/store/schema.ts` and `migrations/`.
- The console client under `src/hosted/client/` is compiled into the committed bundle by
  `scripts/build-client.ts`; regenerate it when those modules change.
