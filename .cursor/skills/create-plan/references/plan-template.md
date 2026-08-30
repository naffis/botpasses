# Research-plan template (workspace dual-write)

`Write` this to `.cursor/plans/YYYY-MM-DD-<slug>.md`. Link the path from the
CreatePlan body. Every section populated; `N/A — <reason>` only when truly
inapplicable. CreatePlan body may be a tighter executive summary.

```markdown
# Plan: <precise name>

## 1. Summary

- Problem:
- Outcome:
- Approach (1 paragraph):

## 2. Scope

### In scope

### Non-goals (with rationale)

### Assumptions (labeled; must not block implementation)

### Open questions

<!-- Must be EMPTY at delivery. -->

## 3. Current state (in-repo, evidence-based)

- What exists today:
- Gaps / constraints:
- Reusable components:
- Files read (path — why):

## 4. External research

### Questions investigated

### Sources consulted

| Source | URL | Takeaway |
| ------ | --- | -------- |

### State of the art / common practice

### Pitfalls & anti-patterns to avoid

### Implications for this plan

<!-- adopt / adapt / reject — and why -->

## 5. Requirements

### Functional (EARS, R-01…)

### Non-functional

### Acceptance criteria (Given/When/Then, AC-01…)

### Edge cases & error paths

## 6. Design decisions (mini-ADRs)

### D-01: <title>

- Context / Options / Decision / Informed by / Consequences:

## 7. Technical design

### Architecture / data flow

### Data model & migrations

### APIs / tools / jobs / UI surfaces

### Failure modes & retries / idempotency

### Feature flags / KV / prompt registry (if any)

### Security, privacy, tenancy notes

## 8. Implementation tasks

### T-01: <title>

- Depends on / Touch / Do / Acceptance / Verify:

## 9. Test plan

- Tests to add or extend:
- Regression cases (fails-before / passes-after) if fixing a bug:
- Gate commands expected green (`pnpm -r typecheck`, affected package tests):
- Manual / smoke checks (only what automation cannot cover):

## 10. Rollout & rollback

- Ship steps / Rollback (incl. data) / Monitoring signals:

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |

## 12. Definition of done

- [ ] All ACs pass
- [ ] Typecheck + affected tests green
- [ ] Docs / changelog / surfaces registered in the SAME change
- [ ] No stubs, TODOs, or deferred dependencies left in-scope
- [ ] External research recorded and reflected in decisions
- [ ] plan-ban-sweep RECEIPT quoted; `plan-checker` PASS
```
