---
name: deep-dive
description: >
  Take a brief seed (thought, idea, feature request, or bug) and investigate
  until a committed recommendation. Use when the user says "deep dive:",
  "dig in:", "deep-dive", "what's the best way to", "think through this", or
  pastes a half-formed idea and wants research plus real alternatives, not the
  first plausible answer. Classifies idea/feature/bug/problem, scales effort,
  investigates the repo before the web, forces lateral approaches, then one
  self-critique pass. Does not implement. Anti-triggers: "create a plan" /
  "/plan" → create-plan; "dig deeper" / "do it correctly" after a shallow fix
  → do-it-right; mid-build "are we still doing this right" → deep-flight
  (not this skill); research one library → researching-a-dependency;
  already-framed local bug → debugging-an-issue.
---

# Deep dive

You are given a **seed**, not a spec. Investigate until you can commit to the
best solution to the **underlying problem**. Never accept the first plausible
answer. Do not implement in this skill; recommend, then hand off.

## Usage

```
deep dive: should billing live in Stripe Customer Portal or our own settings page?
dig in: users can submit the form twice and get two charges
```

## Trigger

- User says `deep dive:`, `dig in:`, `deep-dive`, "what's the best way to",
  "think through this", or pastes a brief thought and wants it taken seriously
- A seed is too thin for `create-plan` and too open for a one-line fix

Not this skill:

| Situation                                            | Use instead                |
| ---------------------------------------------------- | -------------------------- |
| "Create a plan for X" / `/plan`                      | `create-plan`              |
| "dig deeper" / "do it correctly" after a shallow fix | `do-it-right`              |
| Mid-build "are we still doing this right?"           | `deep-flight`              |
| Everyday red test already framed                     | `debugging-an-issue`       |
| Proven class root, implement the fix                 | `root-cause-fix`           |
| Unfamiliar API/library to adopt                      | `researching-a-dependency` |
| "What workflow should I run?"                        | `getting-started`          |

`dig in:` is this skill. `dig deeper` is `do-it-right`.

## Workflow

### 0. Classify and scale

**Class** (pick one):

| Class       | Signals                                            | Entry path                                                                   |
| ----------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| **idea**    | half-formed thought, "what if", no requested shape | Interrogate the job-to-be-done, then research                                |
| **feature** | "add/build/support X"                              | Codebase archaeology, then external, then options                            |
| **bug**     | broken/wrong/failing behavior                      | Reproduce/trace and root-cause **before** any solution space                 |
| **problem** | pain without a proposed fix ("this is messy")      | Interrogate, then treat as feature or bug once the underlying issue is named |

**Mode** (pick the lightest that fits; state it and why):

| Mode         | When                                               | How far                                                                    |
| ------------ | -------------------------------------------------- | -------------------------------------------------------------------------- |
| **LIGHT**    | typo, rename, one-line, no design fork             | Short answer. Skip steps 3–6. Bugs still name the cause in one line.       |
| **STANDARD** | typical feature or bug, bounded                    | Full process, 2 approaches, all three forcing functions, short self-review |
| **FULL**     | new capability, architecture, or ambiguous problem | 2–4 approaches, all three forcing functions, full self-review              |

Effort ceiling means skip the process, not dilute it. Once you are in STANDARD or FULL, run the creativity bar in full. Do not expand a LIGHT seed into a rewrite.

### 1. Interrogate the seed

1. Restate it in your own words.
2. Name the **underlying problem**, not the stated solution. If they asked for a
   thing, ask what the thing is for.
3. Surface hidden assumptions. If the framing is wrong, or a better problem sits
   underneath, say so **before** researching solutions.
4. Ask clarifying questions **only** if the answer changes direction. Otherwise
   state assumptions explicitly and proceed.

### 2. Investigate locally (features and bugs)

Repo before the web. Skip only when the seed is not about this codebase.

1. How this area works today. Patterns already here. Prior art or a previous
   attempt. Constraints the current architecture imposes.
2. Read the live code, tests, and nearby docs. For a large unfamiliar area,
   dispatch the `explorer` subagent and work from its findings.
3. **Bugs:** reproduce or trace the failure path. Find the root cause, not the
   symptom. Then ask why the bug was possible (five whys, stop at a controllable
   invariant). Distinguish **stop the bleeding** from **fix the disease** and
   address both. A five-whys pass that lands on a structural weakness means the
   real fix is there, not a symptom patch.

Evidence precedence: live code > project docs > AGENTS.md > labeled assumption.

### 3. Research externally

Skip only if the seed is purely internal and external practice is irrelevant.
Say so when you skip.

1. Search for current best practice, prior art, and how strong teams solve this
   now. Prefer primary sources (official docs, specs, engineering blogs, papers,
   source) over listicles.
2. Assume tooling and API knowledge is stale. Verify anything version-specific.
3. Note where sources disagree and why. Cite title + URL + takeaway.

For an unfamiliar dependency that might be adopted, hand the deep reference work
to `researching-a-dependency`; keep the recommendation here.

### 4. Explore the solution space

Generate **2–4 genuinely different** approaches, not variations of one idea.
Do not start from "the obvious fix" and decorate it.

Forcing functions (STANDARD and FULL: all three, not adjectives):

- **Other domain:** how a different industry solves the analogous problem.
- **Inversion:** what if we removed or bypassed the thing instead of
  fixing/building it?
- **10x simpler:** what would this look like if it were far smaller? Include a
  "do less" or "don't build this" option when it is defensible.

For each approach: what it optimizes for, what it trades away, rough effort,
failure modes, **second-order effects** (what it breaks, what behavior it trains,
what maintenance it creates). Steelman the approaches you are **not** picking.

### 5. Recommend

1. Pick one. Commit. Give the reasoning chain, not just the conclusion.
2. **Kill criteria:** what evidence would change this recommendation.
3. If building: sequenced next steps, starting with the smallest slice that
   validates the core assumption. Do not implement here.
   - Feature / idea → `create-plan` when they want a buildable plan.
   - Bug → `root-cause-fix` or `do-it-right` when they want the class fix.
4. **Definition of done:** verification criteria for the solution. Bugs include
   a regression test that fails if the fix is reverted.
5. **Out of scope:** state it explicitly. Resist expanding the seed into a
   rewrite.

Flag every choice the user must make as `DECISION:`.

### 6. Self-review (mandatory, exactly one pass)

After drafting, attack the recommendation:

- What would a skeptical senior engineer object to?
- What breaks at 10x load, weird input, or partial failure?
- What is the strongest case that this is the wrong call?

If the critique lands, revise. If it does not, note the objection and why it is
survivable. Never present a first draft as final.

**One pass.** Do not iterate until every objection dies. That produces hedges.
Do not skip this step on STANDARD or FULL. Skip on LIGHT.

### 7. Output

Terse and direct. No filler, no parallel-structure padding, no em-dashes.
Lead with the recommendation, then reasoning, then alternatives, then the
self-review verdict.

**LIGHT:**

```
Mode: LIGHT (<why>)
Recommendation: <two lines>
Cause (bugs): <one line>
```

**STANDARD / FULL:**

```
## Recommendation
<the pick, one short paragraph>

Mode: STANDARD|FULL (<why>)
Class: idea|feature|bug|problem

## Reasoning
<chain, including local findings and cited external sources>

## Alternatives considered
- <approach>: steeled, why it lost
- …

## Done / out of scope
- Verify: …
- Bugs: regression = …
- Out of scope: …

## Next
<smallest validating slice, and which skill to hand off to>

## Self-review
Objection: …
Verdict: revised | survived because …

DECISION: <any choice the user must make>
```

## Guardrails

- Classify before exploring solutions. Bugs do not skip root cause.
- Codebase before the web for features and bugs.
- Never accept the first plausible answer on STANDARD/FULL.
- Do not implement. Do not open a plan file unless they asked for `create-plan`.
- Do not sprawl. Out of scope is a success condition, not a dodge.
- Creativity comes from the forcing functions, not from "think outside the box."
- One self-critique pass, not an endless loop.
- Leave edits unstaged. No commit/push/PR unless asked.

## Pairs with

- rules: `deep-dive-rule`, `no-shortcuts`, `definition-of-done`, `regression-test`
- skills: `getting-started`, `create-plan`, `planning-a-change`, `review-plan`,
  `do-it-right`, `root-cause-fix`, `debugging-an-issue`,
  `researching-a-dependency`, `writing-an-adr`, `running-a-dev-cycle`
- agents: `explorer`
- workflows: `plan-then-build`, `ship-a-feature`, `debug-production`
