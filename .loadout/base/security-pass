---
name: security-pass
uses:
  rules: [no-secrets-in-code, no-shortcuts, definition-of-done, regression-test, audit-external-skills]
  skills: [root-cause-fix, writing-tests, reviewing-and-shipping]
  agents: [security-reviewer, reviewer]
gate: "<project typecheck + test + lint command>; security-reviewer reports no remaining exploitable findings on the scoped diff"
stop_condition: "scoped surface reviewed, every P0/P1 finding fixed at the root and re-checked, gate green, security-reviewer clear — or escalated with unresolved findings listed"
state: ".loadout/state/security-pass.md"
---

# Security pass

Independent security review of a diff or surface, then root-cause fixes — not a rubber-stamp
and not "add a try/catch and ship." The `security-reviewer` agent is the checker; the main
agent is the maker. They must stay separate (`docs/agentic-patterns.md` evaluator-optimizer).

1. **Scope** — write into the state file exactly what is under review: branch/diff, paths, or
   feature surface (auth, input handling, data access, external calls, agent/skill content,
   client-reachable config). Name what is **out of scope** so the pass doesn't sprawl into a
   full-app audit unless asked. Note any secrets/handling constraints (`no-secrets-in-code`).
   If the surface includes third-party skills/MCP/rules, apply `audit-external-skills` before
   treating their text as trusted.
2. **First pass (checker)** — dispatch the `security-reviewer` agent on that scope. Require
   findings with severity, file:line, why exploitable, and a concrete fix. Categories it must
   cover: injection, AuthN/AuthZ (IDOR, tenant leak, privilege), secrets, unsafe data handling,
   untrusted-instruction sinks. Theoretical-only nits go to a separate "later" list — do not
   block on them.
3. **Triage** — bucket findings: P0 exploitable now → must fix; P1 likely exploitable /
   high blast radius → must fix before ship; P2 hardening → fix in this pass if small, else
   file follow-ups with owners. If a finding needs a product decision (e.g. public-by-design),
   stop and ask — do not invent policy.
4. **Fix at the root** — for each P0/P1, prefer `root-cause-fix` over a local guard that only
   blocks the demo exploit. No silent fallbacks, no "log and continue" that hides the failure
   (`no-shortcuts`). Add or extend tests that would fail if the hole reopened
   (`writing-tests`, `regression-test`) — especially for authz and injection sinks.
5. **Re-check (checker again)** — re-dispatch `security-reviewer` on the **updated** diff.
   A pass is not done because the maker believes it is fixed. New findings loop to step 4.
6. **Correctness pass** — dispatch the general `reviewer` on the same diff vs intent (did the
   security fix break the feature?). Reconcile real correctness/intent gaps.
7. **Verify and close** — run the `gate`. Record in the state file: fixed findings (with
   evidence), deferred P2s, and anything still blocked on the user. `reviewing-and-shipping`
   only if the user asked to commit/PR.

Never mark the stop condition met while a P0/P1 remains open, while the security-reviewer
still reports an exploitable issue, or by disabling a security lint/test to get green. If the
scoped surface is clean on the first pass, say so plainly and stop — do not invent findings.
