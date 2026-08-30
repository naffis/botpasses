---
description: Stress-test an implementation plan as a skeptical staff engineer. Update the plan in place; do not implement code.
---

Run the `review-plan` skill in full on the current plan (path in $ARGUMENTS, or the plan in `docs/plans/` / `.cursor/plans/` / this session).

You did not write this plan and you are accountable if it ships broken. Find real gaps. Do not manufacture findings and do not wave it through. Do not write implementation code.

## Checklist (each item: PASS or FAIL + evidence)

- No TBDs, placeholders, "figure out later", or unresolved either/or options
- No unstated assumptions; every assumption is written down and safe
- Edge cases covered: empty and null input, concurrency, partial failure, retries, limits, permissions
- Failure modes and rollback addressed
- Security: authn/authz, input validation, secrets handling for anything new
- Data migration and backward compatibility addressed if data is touched
- Verification plan actually proves the requirements
- No simpler design that satisfies everything (if there is one, that is a finding)
- No conflict with existing code, conventions, or in-flight work you can see

A clean PASS across the board is acceptable only when each item shows what you checked. "Looks good" without evidence is a failed review. Fix every blocker and major **in the plan file**, then report the verdict.

Plan / focus: $ARGUMENTS
