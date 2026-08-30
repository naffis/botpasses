# Loop preflight checklist

Before automating any agent loop (scheduled run, eval campaign, autonomous fix loop), pass
these gates. From the Loop Engineering methodology (`docs/loop-engineering.md`).

## 4-condition test (build a loop only if ALL hold)

- [ ] **The task repeats** (≥ weekly). One-offs: a manual prompt is cheaper.
- [ ] **Verification is automated** — an objective gate (tests / typecheck / lint / build / metric) can reject bad output with no human in the room.
- [ ] **The token budget can absorb waste** — loops re-read context and retry.
- [ ] **The agent has senior tools** — logs, a repro environment, the ability to run what it produced.

## 30-second per-task check

- [ ] Occurs at least weekly.
- [ ] An instant objective check can reject bad output.
- [ ] A live environment exists to run/test changes.
- [ ] A hard stop exists: token cap, timeout, or iteration limit.
- [ ] A human approval gate exists before merge / production.

## Ralph-Wiggum self-test (are you about to ship a silently-failing loop?)

- [ ] There is a **real verifier** (external check), not one agent "reviewing" another in chat.
- [ ] "Done" = an objective pass (build/test/metric), not the agent's own judgment.
- [ ] There are **hard caps** (max tokens / runtime / iterations).
- [ ] The loop re-reads its base spec each iteration so "do not touch" rules don't drift.
- [ ] Maker and checker are **different** agents/models.

## Security tax (unattended loops are an attack surface)

- [ ] Merge gate includes SAST + dependency + secret scanning.
- [ ] External/community skills audited before install (`audit-external-skills`).
- [ ] Verbose logging off in prod; logs sanitized of secrets/PII.
- [ ] Loop token/permission scopes re-audited regularly; no permission creep.

## Execution order (never skip ahead)

Manual run reliable → document it as a skill → wrap the skill in a loop → **only then** schedule it.
Skipping straight to scheduling is the top reason loops fail.

## Related

- Unequipped / brand-new repo → `bootstrap-project` before automating anything.
- Live outage (need stabilize now) → `hotfix-and-rollback`, not a scheduled loop.
- Unattended until-contract-met recipe → `run-autonomous-loop` (only after this preflight passes).
