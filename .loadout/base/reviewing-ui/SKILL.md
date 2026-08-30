---
name: reviewing-ui
description: >
  Run a multi-cycle UI/UX review-and-fix loop on a product through two lenses (first-time
  end user and expert usability reviewer): derive a context brief and screen inventory,
  cold-walkthrough the top jobs, audit against usability heuristics, prioritize findings
  P0-P3 in a UI-REVIEW.md decision log, fix in small batches, re-verify through the
  rendered UI, and repeat until the top jobs pass with zero P0/P1 findings. Triggers on
  "review the UI", "UX evaluation", "usability audit", "improve the design quality",
  "run the UI review cycle", or resuming an existing UI-REVIEW.md. Anti-triggers:
  matching a specific mockup/screenshot -> recreating-a-design; end-to-end product
  behavior (not UI) -> exercising-the-product; a single UI bug -> debugging-an-issue.
disable-model-invocation: true
---

# Reviewing UI

## Role

You are two people working together on this product's UI:

1. **The end user.** Reasonably smart, busy, has never seen this product, does not read
   docs, will abandon anything confusing within seconds. They judge by feel: "do I know
   what this is, do I know what to do next, did that do what I expected."
2. **The expert reviewer.** Senior product designer grounded in interaction design,
   information architecture, and usability heuristics (visibility of system status, match
   to the user's mental model, consistency, error prevention, recognition over recall,
   flexibility for power users, minimalist design, error recovery, help where needed).

Every finding must survive both lenses. If only the expert cares, mark it low priority.
If the end user is blocked, it is a blocker no matter how "correct" the design is.

## Operating rules

- **Evidence over opinion.** Every finding cites a specific screen, route, component, or
  file. Judge the *rendered* product, not the source: run it, click it, screenshot it.
  How to gather UI evidence cheaply and honestly (DOM-first, screenshots at decision
  points, act-then-re-verify, never bypass the interface): `references/ui-evidence.md`.
- **Never redesign for its own sake.** Working, learned patterns stay unless there is a
  concrete usability cost. Novelty is not a fix.
- **Preserve power.** Simplifying the default path must not remove capability.
  Progressive disclosure over deletion.
- **One source of truth.** Maintain a running `UI-REVIEW.md` decision log: every finding,
  its severity, the decision, and the rationale. This file is the durable memory — a
  fresh session resumes from it instead of restarting.
- **Small batches.** Fix in prioritized batches, re-verify, then move on. Never fix
  everything at once.
- **Copy is UI.** Labels, empty states, and error messages get the same scrutiny as
  layout. Name things by what the user controls, not how the system is built. Buttons say
  exactly what happens ("Save changes", not "Submit").
- **Don't manufacture findings.** A cycle that surfaces nothing new is a *result*, not a
  failure. Downgrade honestly and stop; never invent P2s to justify another loop.

## Cycle structure

Run the following as a loop. Each full loop is one cycle. Expect 2–4 cycles; hard cap 5.
Phases 0 and 1 run in the first cycle only.

### Phase 0: Context discovery (first cycle only)

Before judging anything, figure out what this product is and who it serves. Derive it
from the app itself, not assumptions: explore the codebase, routes, marketing copy,
onboarding, README, pricing, docs — and run the app and click through it. Write a context
brief in `UI-REVIEW.md`:

- **Product:** one-line description of what it does.
- **Primary user:** who they are, what they know, what they're paying for.
- **Top 3 jobs to be done:** ranked by prominence in nav, onboarding, and code weight.
- **What "powerful" means here:** advanced capabilities that must stay accessible.
- **Scope:** screens/routes in review; exclusions (admin, dev tooling, dead code) with reason.
- **Constraints observed:** design system, component library, brand patterns already in
  use. These are defaults to respect, not overwrite.

Mark every item **observed** (direct evidence) or **inferred** (best read). Inferred items
are working assumptions: state them, proceed, revise if later phases contradict them. If
two plausible readings of the user or jobs would produce materially different reviews,
pick the better-evidenced one and log the fork.

This brief is the yardstick: a finding is only valid relative to who the user is and what
they're trying to do.

### Phase 1: Inventory (first cycle only)

Map the surface before judging it: every screen/route with its purpose in one sentence
and how the user reaches it; every primary action per screen; the navigation model; all
states per key screen (default, loading, empty, error, success, edge — long text, zero
data, huge data, mobile width). Output: a screen map. Anything whose purpose you could
not state in one sentence is finding #1.

### Phase 2: Cold walkthrough (end-user lens)

Drive the *running app* as a first-time user attempting each of the top 3 jobs, narrating:
What do I think this screen is for? Is the way to do what I want obvious within 5
seconds? After each action, did the system tell me what happened? Where did I hesitate,
guess, or backtrack? Then repeat as a returning power user doing the same jobs fast:
count clicks, look for shortcuts, note anything that punishes repetition.

Output: a friction log — every hesitation, mystery label, dead end, missing feedback
moment, and repetitive-task tax, with location and a screenshot where it helps.

### Phase 3: Expert audit

Systematic pass; grade each dimension (solid / needs work / broken) with evidence:

1. **Information architecture** — grouped how a user thinks, findable where a user would look.
2. **Hierarchy** — the most important thing is visually dominant; exactly one primary action per screen.
3. **Consistency** — same action, same name, same placement, same pattern everywhere.
4. **Feedback and status** — every action produces a visible response; nothing fails silently.
5. **Error prevention and recovery** — destructive actions confirmed or undoable; errors say what happened and how to fix it.
6. **States** — empty/first-run/error states are designed, not accidental.
7. **Clarity of copy** — jargon audit; every label passes "would a new user know what this means".
8. **Efficiency** — smart defaults, short common paths, advanced options that don't crowd the default view.
9. **Accessibility floor** — keyboard navigable, visible focus, contrast, touch targets, reduced motion.
10. **Responsive behavior** — key flows work at mobile width without horizontal scroll or broken layout.

### Phase 4: Prioritize

Merge Phases 2–3 into one ranked findings list in `UI-REVIEW.md`:

- **P0 Blocker** — user cannot complete a core job, or is actively misled.
- **P1 Major** — significant friction/confusion/inconsistency on a core path.
- **P2 Minor** — friction on secondary paths, polish gaps.
- **P3 Polish** — nice to have.

Per finding: location, what's wrong, why it matters (which lens), proposed fix, effort
(S/M/L). Where multiple fixes are viable, state options and recommend one with rationale.
Do not start fixing yet: present the list for approval, or if running autonomously take
all P0s plus the highest-leverage P1s (max ~8 items per batch).

### Phase 5: Fix the batch

Implement the approved batch only. Note each change and why in `UI-REVIEW.md`. Do not
opportunistically "improve" things outside the batch — log new discoveries as findings.

### Phase 6: Verify and re-enter

- Re-run the cold walkthrough on every flow the batch touched — through the rendered UI,
  not by re-reading the diff. A fix you didn't watch work is not verified.
- Regression check: nothing adjacent broke; no learned pattern silently changed; the
  project's gate (typecheck/tests/lints on touched files) is green.
- Update severities: resolved, downgraded, or reopened, with reason.
- For a shippable batch, hand the diff + findings to a fresh-context `reviewer` subagent
  and reconcile before presenting (maker ≠ checker).
- Start the next cycle at Phase 2 (revisit Phases 0–1 only if the surface changed or the
  context brief proved wrong).

## Stop condition

Stop when a full Phase 2 walkthrough of all top-3 jobs yields zero P0/P1 findings AND the
Phase 3 audit grades every dimension "solid" or has an accepted, logged exception — or
when a cycle produces no new P0/P1 and no measurable improvement (plateau), or the cycle
cap is hit. Then produce a final summary: what changed, what was deliberately left alone
and why, and a P2/P3 backlog.

## First response / resuming

Begin with Phase 0; derive context, don't ask for it. Present the context brief and
screen map together at the end of Phase 1 so wrong inferences get corrected early. If
`UI-REVIEW.md` already exists, treat it as the source of truth and re-enter at the phase
it indicates: approved batch unfixed → Phase 5; batch just fixed → Phase 6; otherwise a
fresh cycle at Phase 2.

## Pairs with

- skills: `agentic-loop` (loop discipline), `root-cause-fix` (defects found here),
  `exercising-the-product` (behavior-level loop; UI findings from there land in this log),
  `recreating-a-design` (matching a specific visual target)
- rules: `ui-evidence`, `no-shortcuts`, `definition-of-done`
- agents: `reviewer` (maker-checker on fix batches), `explorer`
- workflows: `run-quality-loop`
