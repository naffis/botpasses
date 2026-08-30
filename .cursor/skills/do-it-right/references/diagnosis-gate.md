# Diagnosis gate — do-it-right Phase 1

## Table of Contents

- [Purpose](#purpose)
- [Evidence first](#evidence-first)
- [Hypothesis set](#hypothesis-set)
- [Falsify, don't confirm](#falsify-dont-confirm)
- [Multi-issue hunt](#multi-issue-hunt)
- [Root descent](#root-descent)
- [Exit criteria](#exit-criteria)

---

## Purpose

Turn a draft diagnosis ("the title contains `permissive`") into a **proven** set
of issues at the right depth. The first finding is privileged only as a
hypothesis to attack.

## Evidence first

Before listing causes, write:

| Kind        | Example                                                |
| ----------- | ------------------------------------------------------ |
| Observation | Tile blurred; API `nsfw=false`; title has `permissive` |
| Assumption  | "Blur is keyed only off the filename heuristic"        |
| Unknown     | Exact predicate + call sites for blur                  |

Convert assumptions into probes. Read the real predicate. Grep callers. Do not
theorize about code you could open.

## Hypothesis set

Minimum **3** competing hypotheses. Categories to force breadth:

1. **Wrong signal** — using name/text when a structured flag exists
2. **Wrong layer** — UI heuristic compensating for missing server rating
3. **Wrong polarity** — false positive vs false negative twin
4. **Stale contract** — flag present but ignored / overridden
5. **Sibling surface** — Files / Preview / chat card disagree

Label the prior proposal as H0 if it maps to one of these. Prefer hypotheses that
disagree with each other so a single probe can kill several.

## Falsify, don't confirm

For each hypothesis, name **one cheap check that would kill it** if the
hypothesis were false. Run cheap checks first (read code, one log, one test).

Weak: "If I exclude this string, the tile looks fine" (confirms a patch).
Strong: "If blur ignores display titles entirely, SFW tiles with `permissive` in
the title stay sharp **and** true NSFW still blurs" (discriminates signal ownership).

## Multi-issue hunt

After one root looks solid, spend a deliberate pass on siblings:

1. **Inverse:** Would the same design fail the other way (NSFW not blurred)?
2. **Callers:** Every consumer of the predicate / helper.
3. **Surfaces:** Chat, Files, Preview, thumbnails, public API.
4. **Data:** Are there other string heuristics for the same concern?
5. **Lifecycle:** Mid-run vs terminal; cached vs live.

Output:

```
Confirmed issues:
1. …
2. … (or "none — single issue proven after hunt")
```

"Only one issue" without this hunt is a skill failure.

## Root descent

For each confirmed issue, write the chain (min 3 links):

```
symptom → proximate → intermediate → ROOT (controllable invariant)
```

Promote to root only if:

- **Completeness** — explains all symptoms for that issue
- **Counterfactual** — correcting it makes the defect class impossible, not rarer
- **Depth** — no deeper controllable cause remains

Session trigger ≠ class root. A false-positive detector match is usually the
trigger; the root is often "blur trust model uses display strings."

## Exit criteria

Phase 1 is done when:

1. ≥3 hypotheses were written; losers have kill evidence
2. Multi-issue hunt completed (result recorded)
3. Every confirmed issue has a root that passes completeness + counterfactual
4. Prior draft proposal is classified: `rejected` | `refined-to-root` | `kept-as-trigger-only`

If you cannot prove root, say what evidence is missing — do not invent a patch.
