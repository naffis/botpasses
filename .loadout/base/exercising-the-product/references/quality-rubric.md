# Building a compounding quality rubric

A quality loop is only as good as its rubric. Two principles from agent-evaluation
practice:

1. **Deterministic checks for exact things; judgment for everything else.** If a script
   can prove it (a link resolves, a section exists, a count matches), never spend a
   vision/judgment pass on it — and never let a judgment pass overrule it.
2. **The rubric compounds.** Every failure mode found in any cycle gets appended as a
   named check, so the next cycle tests for it automatically. A rubric that doesn't grow
   means the loop isn't learning.

## Tier 1 — deterministic checks (scriptable, zero tolerance)

Run these mechanically against the real output (re-fetched, not cached):

- **Request fidelity:** every element the request demanded exists (pages, sections,
  fields, features). A pretty output missing its core deliverable is HIGH, not polish.
- **Dead ends:** no `href="#"` placeholders; every fragment link has a matching `id`;
  every internal route resolves 200; every asset URL loads.
- **Placeholders:** no lorem ipsum, TODO text, or template variables (`{{name}}`) in
  customer-visible output.
- **Structural invariants:** exactly one `h1` per page; images have alt text; nav
  reaches every page; data round-trips (export → import → identical structure counts).
- **Leakage:** no internal jargon, stack traces, or system identifiers in
  customer-visible copy.

Cheap tools: `rg`, `curl -s -o /dev/null -w "%{http_code}"`, `jq`, a 20-line node
script. Prefer writing the check once and pasting the command into the state file.

## Tier 2 — judgment rubric (graded, with evidence)

Grade each dimension solid / needs-work / broken, citing the artifact:

- **Serves the request as a whole** — would the customer who wrote the prompt accept
  this? What would they complain about first?
- **Copy quality** — specific, on-voice, free of filler; buttons and labels say what
  they do.
- **Visual quality** — open the screenshots (desktop, mobile, one in-between width):
  clipping, overlap, contrast, broken/ill-fitting images.
- **Coherence** — the parts fit together (nav matches pages, tone consistent, no
  orphaned sections).

For each "needs work"/"broken": classify **model-variance** (the generative step was
mediocre — log it, consider prompt/model changes, do NOT bolt on brittle
post-processing) vs **code-defect** (something was lost, corrupted, or mis-wired — fix
at the root).

## Tier 3 — process honesty checks

- The product's own quality gate/report agrees with what you observed; a gate verdict
  that contradicts the real artifact is itself a HIGH finding.
- Status/progress messaging matched reality (no "Done!" over a failed build; no
  premature exit mid-promise).
- Errors that occurred were surfaced to the user in an actionable form, not swallowed.

## Appending a new failure mode

When a cycle surfaces a defect class the rubric didn't cover, add it before closing the
session, as a one-line named check under the right tier, phrased so a future session can
run it without context:

```
- [QL-B-4 class] special chars in edit payloads: submit an edit containing `$1` and
  verify the stored content matches byte-for-byte (regex-backreference corruption).
```

Date-stamp additions. If a check stops earning its keep (the class is structurally
impossible now), move it to a "retired" list with the reason — rubrics move, they don't
only grow.
