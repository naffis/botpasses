# Solution selection (no bandaids)

The first fix that comes to mind is almost always at the wrong layer. Treat it as a draft. The
goal is the **correct, scalable, architecture-consistent** fix for the ROOT, chosen over
alternatives you genuinely considered.

## Table of contents

- [Fix at the root layer, never the symptom layer](#fix-at-the-root-layer-never-the-symptom-layer)
- [The bandaid catalog (auto-reject)](#the-bandaid-catalog-auto-reject)
- [Does the mechanism already exist?](#mandatory-before-proposing-any-candidate-does-the-mechanism-already-exist)
- [Generate distinct candidates](#generate-distinct-candidates)
- [The solution scorecard](#the-solution-scorecard)
- [The "100% sure?" gates](#the-100-sure-gates-run-on-the-leading-candidate)
- [Choose and document](#choose-and-document)

## Fix at the root layer, never the symptom layer

A solution that doesn't touch the root-cause node is a bandaid by definition. Pin the root to
its layer, and require the fix to live there — the boundary/contract/schema/default/stage the
descent ended on, not the crash site.

## The bandaid catalog (auto-reject)

If a candidate is one of these, reject it and find the real fix:

- Special-casing the one value / index / type / caller you observed.
- Nudging a threshold/tolerance/timeout so the symptom stops tripping a gate.
- **Narrowing the fix to the observed instance's surface form.** The defect appeared in a
  specific shape, so you propose a rule for that shape. Name the GENERAL class the symptom
  belongs to and fix THAT. If your candidate's name contains the incidental specifics of this
  one case (the input, the caller, the shape), it is almost certainly a band-aid — strip the
  specifics and ask "what is the general defect class?"
- **Scraping a value out of free-text with a regex/keyword list to recover a semantic fact.**
  This is a `no-regex-for-semantics` violation; the fix is a STRUCTURED field from the upstream
  producer, read deterministically downstream.
- A catch-and-swallow, or a fallback that hides the failure with no log/event ("no silent
  fallbacks").
- "The prompt should just tell the model to..." when the real lever is a deterministic
  enforcement point.
- Hardcoding a value (count, key, duration) that should be derived.
- Fixing the test/gate instead of the code it caught.
- A change that only fixes THIS instance, not the class (fails the Class test).

## MANDATORY before proposing any candidate: does the mechanism already exist?

The most embarrassing band-aid is proposing to ADD a check/gate/mechanism that ALREADY EXISTS
and merely failed to fire. Before writing candidate #1, **grep the code** for the mechanism
your fix would add:

- If the check EXISTS and didn't catch the defect -> the root is **the reliability of the
  existing mechanism**, and the fix is to make it fire reliably (a structured field instead of
  a buried one; a deterministic gate instead of a fuzzy score). Do NOT bolt a second, narrower
  mechanism alongside the one that already failed.
- If a prior "fix" for this exact symptom exists and is itself a band-aid, your fix REPLACES
  it, and you say so.

## Generate distinct candidates

Produce at least **three** candidates that differ in MECHANISM (not phrasing). At least one
must be the deepest correct fix at the root layer, even if it's the most work. "Three options"
is the floor, not the goal — the goal is the right one.

### Mandatory root-node candidate (write it FIRST)

The single most common way this skill fails: the investigator NAMES the controllable root
node, then proposes a fix at a DIFFERENT layer that routes *around* it (a downstream rescue, a
new mechanism). The fix must live AT the node the descent ended on.

So **candidate #1 is always: the smallest change to the EXACT node/function/branch the root
cause named** — written out concretely (the file, the function, the condition), before any
other candidate is allowed on the list. A clever mechanism is only admissible AFTER the
smallest-root-node change is on the list and was found insufficient for a stated reason. If
your candidate set does not contain a change to the node you just named, you have not generated
the required candidate — stop and write it.

Two biases this defeats:

- **"A critical bug deserves a big fix."** A one-line condition on the root node feels
  anticlimactic for a severe defect, so the impressive mechanism gets proposed and the correct
  small fix never makes the list. Severity does not determine fix SIZE; the causal chain does.
- **Authority-anchoring on a pre-blessed idea.** A half-formed idea already in a doc/comment
  arrives pre-blessed and becomes the answer without being re-derived. Treat any suggested fix
  as a HYPOTHESIS to test against the causal chain like every other candidate.

### Mechanism-to-node mapping (cut anything off the chain)

For EVERY candidate, name the exact causal-chain node it addresses. A candidate whose mechanism
maps to **no node on the chain you built** is cut — it is either a bandaid (below the root) or
over-engineering (a mechanism for a problem not on THIS chain). The minimal fix is whatever
makes the named chain impossible, and nothing more.

## The solution scorecard

Score every candidate on all axes. A candidate that fails **Correctness** or the **Bandaid
test** is rejected regardless of how cheap it is.

| Axis | Question | Reject if |
| --- | --- | --- |
| **Correctness** | Does it fix the ROOT and prevent the whole class? | Only fixes this instance / partial |
| **Bandaid test** | Is it masking the symptom vs. fixing the cause? | It's in the catalog above |
| **Blast radius** | What else uses this path? | Unbounded or unexamined regression surface |
| **Scalability** | Does it generalize to all inputs and scale with volume? | One-off; doesn't generalize |
| **Architecture fit** | Consistent with repo invariants (deterministic enforcement, no-regex-for-semantics, size limits, an event on new failure paths, definition-of-done)? | Violates an invariant |
| **New failure paths** | Does it add a path that could fail silently? | Any silent fallback / no event |
| **Cost/complexity** | Effort, files, tests. | **Tie-breaker only** — never decides over correctness |

## The "100% sure?" gates (run on the leading candidate)

Before committing, challenge the winner — actively try to break your own choice:

- **Would it cause other problems?** Name 2-3 concrete ways it could go wrong (other inputs,
  edge cases, interaction with another feature). If you can't think of any, look harder.
- **Is there a better/more correct way you dismissed too fast?** Re-open the rejected
  candidates; confirm the rejection still holds with your deeper understanding.
- **Is it the GENERAL class fix, or did I narrow it to this instance?** If the candidate's name
  mentions the specifics of THIS case, generalize it.
- **Did I confirm the mechanism doesn't already exist?** If the fix adds a check that already
  exists (and merely didn't fire), fix the existing mechanism's reliability instead.
- **Is it quality + scalable, or a local patch?** Would you defend it in a strict review as the
  way this SHOULD work, not "good enough for now"?
- **Does it close the class?** Re-run the Counterfactual + Class test on the FIX: with this in
  place, is the original defect impossible for every input in the class?
- **Does it respect the contract?** Definition-of-done implications (tests, docs, changelog,
  surface registration) named.

If any gate is shaky, the candidate is not final. Iterate or pick another.

## Choose and document

State the CHOSEN solution, WHY it's correct at the root layer, WHY each alternative was
rejected (especially any cheaper bandaid), the regression/blast radius you accept and how it's
bounded, and the verification that would prove it (the test that fails today and passes after,
per `regression-test.mdc`).
