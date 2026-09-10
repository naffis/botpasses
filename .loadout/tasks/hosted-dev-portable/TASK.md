# Task: hosted-dev-portable

## Outcome

`npm run hosted:dev` boots the hosted kernel on loopback with sqlite-hosted (or Postgres if `--postgres` / `VAULT_HOSTED_DEV_DATABASE_URL` is set). It does not inherit a leftover `DATABASE_URL`. Plane `dev` binds `127.0.0.1` when `VAULT_BIND_HOST` is unset. `FLY_APP_NAME` plus plane `dev` is exit 78. Hosted connect on loopback uses `/connect/callback`, not port 8888. Self-host accepts any Postgres 16 URL and any non-platform-default `https` origin. First-party staging/production still pin botpasses.com hostnames and still refuse SQLite.

## Spec pointer

- Plan: `docs/plans/2026-09-10-hosted-dev-and-portable-self-host.md`
- Cursor CreatePlan: Hosted-dev and portable store

## Topology

- Choice: single-loop
- Escalation test 1 (disjoint files / no data dep): FAIL — T-01 through T-05 share `src/brand.ts`, `src/hosted/boot.ts`, `src/hosted/main.ts`, `src/hosted/kernel.ts`, and site/docs assertions
- Escalation test 2 (independent verifiers): FAIL — boot tests cannot pass until origin policy and store open exist; site-content cannot pass until copy matches
- Rationale: overlapping files and one boot contract. Graph would collide on the shared trunk.

## Shared contract

- Path: N/A for single-loop
- Editor: N/A

## Full-suite verifier

```bash
npm run lint && npm test && npm run typecheck
```

Site-content after `npm run site:build`.

## Units

None. Implement T-01 through T-05 in one change.

## Merge order

1. Whole change

## Isolation mode

Shared trunk. Do not create a branch or worktree. Do not stash. Leave edits unstaged unless the user asks to commit.
