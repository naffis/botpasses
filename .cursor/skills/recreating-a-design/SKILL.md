---
name: recreating-a-design
description: >
  Recreate an image, mockup, or live website as well-structured, responsive HTML/CSS —
  or push an existing implementation to match a visual target — by iterating a
  render -> measure -> look-at-the-diff -> diagnose -> smallest-fix -> re-measure loop
  autonomously until convergence, budget, or plateau. Keeps the best-scoring version and
  never ships a regression. Triggers on "recreate this", "match this mockup", "pixel
  perfect", "clone this site/screenshot", "image to code", "make it look exactly like",
  "iterate on fidelity". Anti-triggers: holistic UX quality -> reviewing-ui; end-to-end
  product behavior -> exercising-the-product.
---

# Recreating a design

Turn a visual target into a matching implementation, and drive the whole loop yourself:
render, measure the difference, look at it, fix the smallest high-impact thing,
re-measure, repeat. **Do not stop after one pass and ask "what next" — keep iterating
until a stop condition is met, then report with evidence.**

Naive image-to-code (ask a vision model to free-write HTML from a screenshot and hope)
plateaus fast: VLMs are unreliable at coordinates and can't grade their own output. The
reliable pattern is a **closed measurement loop**: render a fresh build every round,
compare it to the target mechanically, and let the *difference image* tell you what to
fix next.

## Phase 0 — Establish the target and the measurer

- **Target:** the user's image file; or a screenshot of a live URL you capture yourself
  (same viewport you'll render at); or a mock you generate and save. One target image
  per page/viewport.
- **Measurer:** use the project's fidelity harness if it has one (SSIM/overlay scoring,
  a `remeasure` command). If not, build the minimal one — Playwright screenshots + a
  pixel diff — in a few minutes: see `references/diff-and-diagnosis.md`. Do not iterate
  unmeasured.
- **Thresholds:** state them up front (e.g. SSIM ≥ 0.95, or "no bright regions larger
  than a caption in the overlay"), plus the responsive invariant: no horizontal overflow
  or overlap at mobile width. Any single metric alone lies; converge on score AND
  overlay AND responsiveness together.
- **Preconditions:** whatever the render pipeline needs (dev server, container, API
  keys) — verify before looping, not midway. If capture fails, fix the environment;
  never report an unmeasured run as converged.

## The loop

```
1. BASELINE → full render of the current implementation; measure vs target
2. LOOK     → open the diff/overlay image with the Read tool (you are a vision model —
              looking at the difference is how you localize the problem)
3. DIAGNOSE → name the 1–3 biggest deviations, using the overlay taxonomy
4. LOCUS    → instance or generator? (see below)
5. FIX      → the smallest change that kills the biggest deviation
6. MEASURE  → re-screenshot + re-diff (fresh build, never a cached render)
7. COMPARE  → better? keep. worse? revert before the next attempt.
8. repeat 2–7 until a stop condition, then REPORT
```

One fix per round. Batch fixes hide which change helped and which regressed.

Reading the overlay (bright = deviation, black = match) and the
symptom → cause → fix-location taxonomy: `references/diff-and-diagnosis.md`.

## Fix locus: instance vs generator

- **Instance (default, fast):** the failure is specific to THIS page — this section's
  spacing, this palette, this missing block. Edit the implementation directly and
  re-measure. Tight loop, no regeneration cost.
- **Generator (generalize, riskier):** the output comes from a pipeline/template/
  generator and the failure is SYSTEMIC — it would happen for any similar target. Fix
  the generator and re-run the full generation. Before a generator change, capture the
  scores of any other targets/fixtures it serves; after, re-measure them all so you
  don't fix one image and regress the rest. For anything beyond a small safe tweak,
  propose the change to the user first.

Heuristic: the SAME defect class on 2+ different targets → generator problem. One-off →
instance.

## Stop conditions (first that hits)

1. **Converged** — all stated thresholds met, including the responsive invariant.
2. **Budget** — default 6 fix iterations per target (state it up front; the user can
   raise it). Stop, report best result + remaining gaps.
3. **Plateau** — 2 consecutive iterations improve the score by less than a meaningful
   step. Switch tactic once (different fix locus, different deviation), else stop.
4. **Blocked** — capture broken, keys missing, or the right fix needs a product
   decision. Stop and explain precisely.

Always keep the best-scoring version; never end on a regression.

## Guardrails

- **Don't fake success.** Scores and overlays come from the measurement artifacts, not
  your own impression of the render. Read the actual report/diff each round.
- **Don't overfit to one viewport.** Output stays semantic, responsive markup (real
  headings and paragraphs, flex/grid, fluid type) — never absolute-positioned div soup.
  A clone that only matches at one width is a fail. Check mobile and one in-between
  width every few rounds.
- **Match, don't plagiarize.** When cloning a live site, recreate layout and structure
  with your own assets and copy unless the user owns the source.

## Output discipline

Each round, post a short status: current score, what the diff showed, the one fix
applied, with the overlay/before-after images embedded (`![](path)`) so the user watches
progress. At the end: the score trajectory (e.g. 0.71 → 0.88 → 0.94), the final
artifacts path, and any gap that needs a human decision.

## Pairs with

- skills: `agentic-loop` (loop discipline), `reviewing-ui` (holistic UX after fidelity),
  `root-cause-fix` (systemic generator defects)
- rules: `ui-evidence`, `no-shortcuts`
- workflows: `run-quality-loop`
