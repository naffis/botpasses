# Worked examples — do-it-right

## Table of Contents

- [Example A — False-positive 18+ blur from title text](#example-a--false-positive-18-blur-from-title-text)
- [Example B — "Classifier false positive" as the whole story](#example-b--classifier-false-positive-as-the-whole-story)

---

## Example A — False-positive 18+ blur from title text

**Symptom.** Platform Files/chat tile is blurred (18+ treatment). API/content
says `nsfw=false`. Session title looks like
`[gen-loop] SFW ads-static-…` / pink footer chrome; output name may include
`permissive-plain_…` from a workflow id even for SFW work.

**Draft proposal (H0 — reject as Chosen Fix).**  
"Tighten the heuristic so SFW ad-set names aren't treated as 18+."

### Phase 1 sketch

| Hypothesis                        | Probe                                      | Result (illustrative)     |
| --------------------------------- | ------------------------------------------ | ------------------------- |
| H0 Name substring `permissive`    | Read blur predicate                        | Trigger confirmed         |
| H1 Blur ignores `nsfw` flag       | Trace flag → UI                            | Often the class root      |
| H2 Display title vs file metadata | Which string is passed into the predicate? | May be second issue       |
| H3 True NSFW path also broken     | Fixture with `nsfw=true`, clean name       | Inverse must stay blurred |

**Multi-issue hunt.** Check Preview rail, Files browser, thumbnails, any
shared `isNsfwBlur` helper — one wrong helper can fan out.

**Root (class).** Blur / 18+ chrome is driven by **display-string heuristics**
(or workflow-id tokens) instead of a **structured content rating** (file/
run `nsfw`, library policy, entitlement). The `permissive` substring is the
**session trigger**, not the fix surface.

### Phase 2 sketch

| Candidate                                                                                      | Verdict                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Exclude `ads-static` / `SFW` from the regex                                                    | **Reject** — bandaid; next token will match |
| Special-case gen-loop titles                                                                   | **Reject** — carve-out                      |
| Blur only when structured `nsfw===true` (or equivalent SoT), stop using name tokens for rating | **Choose** — class-kill                     |
| If SoT missing, stamp rating at write time                                                     | **Choose / pair** if flag absent at source  |

**Implement.** Fix the SoT + consumers; regression: SFW title containing
`permissive` stays sharp; NSFW with innocuous title stays blurred.

**User prompt this skill replaces.**  
"Yes, fix it. Do it correctly." → run Phases 0–4 without re-asking.

---

## Example B — "Classifier false positive" as the whole story

**Symptom.** Brief enters a bad planning mode; output has forbidden physics.

**Draft proposal.** "Don't match phrase X in the classifier."

**do-it-right move.** Treat classifier match as **trigger**. Hunt whether the
engaged mode/path still produces the defect for true members. Solutions that
only narrow the detector while the owning path stays broken → auto-reject.
Hand off to `root-cause-fix` for the class fix at the owning layer.

See `no-shortcuts.mdc` (proximate-patch ban) and `root-cause-fix`.
