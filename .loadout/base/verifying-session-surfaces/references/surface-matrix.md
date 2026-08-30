# Session files → surfaces

## Table of Contents

- [Goal](#goal)
- [Collapse rule](#collapse-rule)
- [Classification](#classification)
- [Feature / function rows](#feature--function-rows)
- [Composed surfaces](#composed-surfaces)
- [Shared-tree scope](#shared-tree-scope)

## Goal

The inventory script lists **files**. This pass lists **surfaces** — the
thing a user or caller hits. One route, endpoint, command, tool, or job
is one row even if ten files changed underneath it.

## Collapse rule

Group paths that share a user-facing identity:

| Files look like                  | Surface identity                                                  |
| -------------------------------- | ----------------------------------------------------------------- |
| page + island + hook + CSS       | one UI route or sheet                                             |
| route handler + schema + OpenAPI | one HTTP method + path                                            |
| MCP tool schema + dispatcher     | one tool name                                                     |
| CLI command module + flag parse  | one command + subcommand                                          |
| Inngest/cron/worker handler      | one job name + trigger                                            |
| flag catalog + read site         | one flag id + default                                             |
| migration + repo + type          | one schema contract (exercise via the consumer, not `psql` alone) |

If you cannot name the surface in one noun phrase, you have not collapsed
enough — or the change is library-only (`code`). Library-only still needs
a claim: name the **nearest consumer** this session touched and exercise
that. If no consumer changed, run the existing tests for the module and
mark the surface `N/A` with the test command as evidence.

## Classification

The script's labels are a hint, not a verdict. Re-read the file when the
hint is wrong (a `*.tsx` email template is not a UI route).

| Label      | Typical paths                                               | Exercise layer                                                       |
| ---------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `ui`       | `*.tsx` / `*.astro` / `components/` / `pages/` / `islands/` | rendered UI (`ui-evidence`)                                          |
| `api`      | `http/` / `routes` / `openapi`                              | real HTTP against the local/dev origin                               |
| `mcp`      | `mcp/`                                                      | actual tool invocation                                               |
| `cli`      | `cli/` / `bin/`                                             | terminal transcript                                                  |
| `job`      | inngest / cron / worker handlers                            | trigger the job the way prod would                                   |
| `realtime` | SSE / websocket / ws-ticket / EventSource                   | real upgrade or event stream, not a unit mock                        |
| `flag`     | feature-flag catalog + read sites                           | both default-off and default-on (or the session's intended default)  |
| `schema`   | migrations / drizzle schema                                 | consumer path + migrate dry-run if the repo has one                  |
| `test`     | `*.test.*` / `*.spec.*`                                     | run them; they do not replace a live surface                         |
| `docs`     | `*.md`                                                      | only a surface if the change is user-facing copy or a taught command |
| `code`     | everything else                                             | nearest consumer, or existing module tests                           |

## Feature / function rows

Surfaces are not only files. Add a row when the **ask** created or
changed behavior with no dedicated file (bind rule, empty state, error
copy, flag default, "Decide for me"). Source those from the verbatim
user messages + the inventory, never from chat memory of "what we
meant to do."

A matrix that only mirrors `kind_counts` and drops file-less ask rows
is incomplete — `flight-checker` should FAIL it.

## Composed surfaces

When inventory (or the ask) touches **two layers that call each other**,
add one surface whose identity is the join, not either side:

| Changed together      | Composed identity                        |
| --------------------- | ---------------------------------------- |
| UI + API              | the click/submit that hits the new route |
| CLI + API/MCP         | the command the user would type          |
| MCP + HTTP dispatcher | the tool name as the host invokes it     |
| Job + webhook         | the event that lands and the side effect |

Isolated `WORKS` on each side does not prove the join.

## Shared-tree scope

On a dirty shared trunk, pass this session's paths as args to
`session-inventory.sh`. Do not verify, "fix," or inventory files another
agent owns. If ownership is unclear, stop and ask — do not guess.
