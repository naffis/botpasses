# Task: marketing-site-and-docs

## Outcome

Hosted origin serves marketing + docs from `site/dist`, first-party operator auth, same-origin OAuth AS, Access panel. No Clerk. Gate: `npm --prefix site ci && npm --prefix site run build && npm test && npm run typecheck`

## Spec pointer

- Plan: [docs/plans/2026-08-31-marketing-site-and-docs.md](../../../docs/plans/2026-08-31-marketing-site-and-docs.md)

## Topology

- Choice: single-loop
- Escalation test 1: FAIL — shared `http.ts`, console HTML, Docker, CI, tests
- Escalation test 2: FAIL — `site/dist` feeds HTTP tests and the image
- Rationale: file sets overlap; one loop

## Shared contract

- N/A (single-loop)

## Full-suite verifier

`npm --prefix site ci && npm --prefix site run build && npm test && npm run typecheck`

## Units

(none — single-loop)

## Isolation mode

shared trunk (`dev`). Do not branch.
