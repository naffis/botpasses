# Worked example: topology triage

Concrete escalation decisions. Prefer the simpler topology when uncertain.

## Case A → single-loop (default)

**Ask:** Add a null-check and regression test on `parseDuration`.

| Candidate unit | Files | Verifier |
| --- | --- | --- |
| (one) | `src/time.ts`, `src/time.test.ts` | `npm test -- time` |

Escalation: only one unit → **single-loop**. Write a minimal TASK.md
(`Choice: single-loop`, units omitted or one informal unit) and run `agentic-loop`.

## Case B → pipeline (overlap / data dep)

**Ask:** Add a `Widget` API route + DB migration + OpenAPI update.

| Unit | Files | Verifier |
| --- | --- | --- |
| U-01 migrate | `migrations/0042_*.sql`, `src/db/schema.ts` | `npm run db:migrate:test` |
| U-02 handler | `src/routes/widgets.ts`, `src/routes/widgets.test.ts` | `npm test -- widgets` |
| U-03 openapi | `openapi.yaml`, `src/db/schema.ts` | `npm run openapi:check` |

U-01 and U-03 both touch `schema.ts` → intersection → **not graph**.
U-02 needs migrated schema → data dependency → **not graph**.

**Choice: pipeline.** Merge/exec order: U-01 → U-02 → U-03. Shared contract holds
request/response types + error codes. Each stage: implement-node → unit verifier →
next. `integrate` still runs the full suite after each stage lands.

## Case C → graph (both tests pass)

**Ask:** Add independent CLI formatters for JSON and YAML export (no shared modules
beyond a pre-written contract).

| Unit | Files | Verifier |
| --- | --- | --- |
| U-01 json | `src/export/json.ts`, `src/export/json.test.ts` | `npm test -- export/json` |
| U-02 yaml | `src/export/yaml.ts`, `src/export/yaml.test.ts` | `npm test -- export/yaml` |

Allowlists disjoint. Contract (written in `decompose`) defines `ExportRecord` and
`Exporter` interface both import. Each verifier runs without the other unit's files.

**Choice: graph.** Dispatch both implement-nodes (≤3 concurrency). Merge order for
`integrate` (e.g. U-01 then U-02) still sequential with full-suite after each merge.

## Case D → refuse graph (missing verifier)

Same as C, but "we'll typecheck the whole package at the end" is the only check.

Escalation test 2 **FAIL**. Fall back to **single-loop** (or pipeline with a real
per-unit test added in decompose). Do not spawn unverified parallel agents.
