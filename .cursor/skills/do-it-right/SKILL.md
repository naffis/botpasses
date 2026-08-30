---
name: do-it-right
description: >
  Gateway when the user says "yes, fix it", "do it correctly", "dig deeper",
  "don't bandaid", "find the real issue", or approves a shallow proposal ("Want
  me to tighten X?"). Re-diagnose from scratch: treat the first finding as a
  draft, hunt for additional issues, generate ≥2 real solutions with trade-offs,
  reject proximate/heuristic patches, then implement the class-kill fix via
  root-cause-fix or debugging-an-issue. Use so the user never has to re-prompt
  for thoroughness. Anti-triggers: everyday red test already framed →
  debugging-an-issue; plan exhaustion → complete-the-build; investigate-only →
  debugging-with-observability; seed thought / "deep dive:" / "dig in:" →
  deep-dive (not this skill; "dig deeper" stays here).
---

# Do it right

You already know a symptom. Someone (often you) proposed a quick fix. The user
said yes — or asked you to do it correctly. Your job is **not** to implement that
first proposal. Your job is to prove the real issue(s), pick the correct
solution, then fix the class.

This skill is the **gateway**. It does not replace `root-cause-fix` or
`debugging-an-issue`; it forces the dig-deeper contract **before** those implement.

Industry anchors (hypothesis-driven debugging): enumerate competing falsifiable
hypotheses before editing; prefer falsification over confirmation; stop only when
one cause explains **all** symptoms; fix the systemic/controllable layer, not the
detector exception. Repo doctrine: `no-shortcuts.mdc` + `root-cause-fix`.

## Trigger

Invoke when any of these are true:

- User: "yes, fix it", "do it correctly", "dig deeper", "don't bandaid", "find
  the real issue(s)", "properly", "root cause and fix", "not a shortcut"
- You just proposed a proximate patch ("tighten the heuristic", "add an
  exception", "carve out this name", "bump the threshold") and the user approved
- You are about to ask "Want me to …?" for a symptom-layer patch — **stop**, run
  this skill instead of asking

## Immediate action

1. Read the `do-it-right` rule (`rules/do-it-right.mdc`) — hard bans.
2. Read `references/diagnosis-gate.md` and `references/solution-gate.md`.
3. **Do not edit production code** until Phase 3 prints a Chosen Fix with
   rejected alternatives.
4. Do not commit/push/PR unless the user explicitly asks.

## When to use vs neighbours

| Situation                                                              | Skill                                    |
| ---------------------------------------------------------------------- | ---------------------------------------- |
| "Yes / fix it / do it correctly" after a shallow diagnosis or proposal | **This skill** (then handoff)            |
| Proven class root; implement class-kill + regression                   | `root-cause-fix`                         |
| Everyday red test / typecheck / local repro already framed             | `debugging-an-issue`                     |
| Investigate only, no fix commitment                                    | `debugging-with-observability`           |
| Seed thought / "deep dive:" / "dig in:" (recommend, don't implement)   | `deep-dive`                              |
| Mid-build after Chosen Fix — still on the class path?                  | `deep-flight`                            |
| Session wrap / shipping checklist                                      | `reviewing-and-shipping` / `post-flight` |

## Workflow

### Phase 0 — Frame (no edits)

Write in the reply:

1. **Symptom** — observed vs expected (one sentence each).
2. **Prior proposal** — what was offered (or what you were about to offer). Label
   it `DRAFT — not committed`.
3. **Trigger vs class** — name the session trigger separately from the candidate
   class root (trigger ≠ class root — `no-shortcuts`).

### Phase 1 — Re-diagnose (discard first-answer privilege)

Run `references/diagnosis-gate.md` in full:

1. Collect raw evidence (code path, flags, logs, UI state) — assumptions ≠ facts.
2. List **≥3 competing hypotheses** (falsifiable). The prior proposal is at most
   one of them, usually the shallowest.
3. Falsify cheapest-first. Cite evidence that kills each rejected hypothesis.
4. **Multi-issue hunt (mandatory):** ask "what else would produce this class of
   wrongness?" Walk callers, sibling surfaces, inverse false-negatives. Record
   zero or more _additional_ confirmed issues — "only one issue" is a claim you
   must earn, not a default.
5. Descend with ≥3 "why?" links to a **controllable invariant** (owning layer).
6. Exit Phase 1 only when completeness + counterfactual gates pass for every
   confirmed issue.

### Phase 2 — Solution selection (no edits yet)

Run `references/solution-gate.md` in full:

1. For each confirmed issue, generate **≥2 distinct real solutions** (different
   layers or contracts — not two spellings of the same exception list).
2. Score with the scorecard (class-kill, correct layer, no bandaid, DoD cost).
3. Auto-reject anything in the bandaid catalog (heuristic tighten, keyword
   carve-out, threshold nudge, satisfy-the-audit waiver).
4. Print **Chosen Fix** + **Rejected** with one-line why for each reject.
5. If the leading candidate is still the prior shallow proposal, you failed —
   keep going or escalate with evidence.

### Phase 3 — Implement via the right owner

| Issue class                                    | Hand off to                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------- |
| Non-trivial defect class / production bug      | `root-cause-fix` (re-confirm Phase 1 exits)                             |
| Everyday local bug with clear repro            | `debugging-an-issue` steps 4–7 (hypotheses already done)                |
| UI / product heuristic / blur / naming / flags | Implement here under `no-shortcuts` + regression test; still class-kill |

Implement **all** confirmed issues from Phase 1 in this pass when they share a
root or are cheap siblings. Do not ship the first issue and leave the rest as
"follow-up."

After a non-trivial implement, run `deep-flight` before claiming done.
Routing: `_shared/flight-family.md`. Quote a shortcut-sweep RECEIPT and
launch `flight-checker` (readonly).

### Phase 4 — Prove

1. Regression test that fails if the fix is reverted (`regression-test.mdc`).
2. Sibling / inverse case: at least one path that must still behave correctly
   (true positive still protected; false positive class impossible).
3. Consumer-path trace: name the call sites / surfaces covered.
4. Applicable `definition-of-done.mdc` rows in the same change.
5. Shortcut RECEIPT — run the project's `shortcut-sweep.sh` (loadout ships
   `plugins/core-engineering/skills/_shared/scripts/shortcut-sweep.sh`; equipped
   repos: `.cursor/skills/_shared/scripts/shortcut-sweep.sh`) and quote it.
6. Isolated `flight-checker` on behavioral fixes (readonly, no `resume`).
   Same-session self-grade cannot close Phase 4.

### Phase 5 — Report

```
## Do-it-right report
- Symptom:
- Prior draft proposal (rejected / refined):
- Confirmed issues (N): …
- Hypotheses eliminated: …
- Chosen fix(es) + layer:
- Rejected alternatives:
- Class-kill attestation (sibling that must now be impossible):
- Tests / gates:
- Residual risk (only if real; else "none"):
```

## Never do

- Implement the first proposal because the user said "yes"
- Ask "Want me to tighten/exclude/carve-out …?" — diagnose and choose instead
- Stop at one issue without a multi-issue hunt
- Present one solution as the only option
- Ship a keyword/heuristic exception as the class fix when a structured signal
  exists (flag, rating, content type, ownership)
- Declare done without a regression that pins the class

## Worked shape (motivating case)

See `references/worked-examples.md` — false-positive 18+ blur because a session
title contained the substring `permissive` while `nsfw=false`. Correct path is
structured rating / ownership of blur, not "exclude SFW ad-set names from the
heuristic."

## Pairs with

- rules: `do-it-right-rule`, `no-shortcuts`, `regression-test`,
  `definition-of-done`
- skills: `root-cause-fix`, `debugging-an-issue`, `deep-flight`, `agentic-loop`,
  `reviewing-and-shipping`, `post-flight`
- agents: `flight-checker`, `reviewer`
- commands: `do-it-right-cmd` (`/do-it-right`)
- refs: `references/diagnosis-gate.md`, `references/solution-gate.md`,
  `references/worked-examples.md`
