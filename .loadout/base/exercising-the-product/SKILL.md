---
name: exercising-the-product
description: >
  Run the product's own end-to-end pipeline against itself in a create -> observe ->
  analyze -> exercise-the-mutations -> fix -> iterate loop: drive real scenarios through
  the running app as a demanding customer, judge every artifact against a compounding
  rubric, verify process health from ground-truth evidence (events, logs, rendered
  output), root-cause and fix every confirmed defect with a fail-on-revert regression
  test, and leave a ledger so the next run starts smarter. Triggers on "exercise the
  product", "run the quality loop", "dogfood the app", "self-test the product",
  "eval generations end to end", "find and fix issues end to end", or resuming a
  quality-loop STATE file. Anti-triggers: a single known bug -> root-cause-fix; UI/UX
  polish -> reviewing-ui; matching a visual target -> recreating-a-design.
disable-model-invocation: true
---

# Exercising the product

Create → observe → analyze → exercise the mutations → fix → iterate. You are both the
**customer** (does the output actually serve the request?) and the **on-call engineer**
(did every stage of the pipeline behave, and if not, why exactly?). A finding is only
real when you can point at the evidence — an event row, a log line, a screenshot,
rendered output.

This skill IS an agentic loop (`agentic-loop`) whose fix step delegates to
`root-cause-fix`. Non-negotiables inherited from both: write the contract first, verify
against ground truth, fail-on-revert regression test per fix, maker ≠ checker for
shippable fixes, edits stay unstaged, never commit unasked.

One pass = one **exercise cycle**. The skill is designed to run repeatedly: the scenario
matrix and quality rubric are living documents — every new failure mode you find gets
appended so the next cycle checks for it automatically. That compounding is the point.

## Durable state (read FIRST, write constantly)

Keep a session state file (default `_local/quality-loop-STATE.md`, or the project's
convention; see `references/session-state.md` for the format). It holds the contract,
the status checklist, the mutation matrix results, and the **issues ledger** —
append-only, one line per issue:
`ID · severity · surface · symptom · evidence · root cause · fix · status`.

If the file exists, resume where it says: do not re-run finished scenarios or re-fix
closed issues. Check the **known-fixed** and **known-open** sections before filing
anything — re-discovering a logged issue wastes the whole cycle's budget. Check
`git status` before editing; note files another session owns.

## Contract (fill in before the first scenario)

- **End state:** N scenarios of DIFFERENT types executed and deep-reviewed; the mutation
  matrix exercised; every high-severity issue root-caused and fixed with a fail-on-revert
  test; the project's gate (typecheck + affected tests + lints) green.
- **Budget:** max N scenarios per session (default 3) · max 3 edit→verify cycles per fix
  · a run that is silent past its expected duration is *dead — diagnose it, don't wait on
  it*. Escalate blockers instead of thrashing.
- **Constraints:** edits unstaged, no commits; no swallowed errors; fixes at the root
  layer, never symptom patches; plus the project-specific never-do list (below).

## Phase 0 — Preflight (every run)

1. **Stack health.** Probe every service the loop needs (HTTP ports, DB connection,
   queue/worker heartbeat). Record the exact probes in the state file the first time so
   later runs copy-paste them.
2. **Exactly one dev stack.** Duplicate dev supervisors fight over ports and shared
   local state and produce phantom failures. Verify one healthy listener per port before
   blaming the product.
3. **Baseline gates green** (typecheck + tests) so failures you cause later are
   attributable to your changes.
4. **Evidence access ready.** Build the ground-truth map (below) and set up the browser
   harness if the product has a UI (`reviewing-ui/references/ui-evidence.md`).
5. **Record known dev-only noise** (auth stubs, greeting placeholders, benign warnings)
   once in the state file, then ignore it — don't re-triage it every cycle.

## Ground truth — where the evidence lives (build this map once)

Rank the project's evidence sources and record access commands in the state file.
Typical shape:

| Source | What it answers |
| --- | --- |
| event/audit tables or traces | the exact step-by-step of a run: tool calls, errors, gates |
| persisted domain records | what the system claims it produced |
| service logs | crashes, retries, truncations, timeouts (note: terminal capture trims — the DB/trace store is authoritative) |
| rendered output (HTML, files, API responses) | what the customer actually receives |
| debug/health endpoints | stuck sessions, liveness, in-memory state |
| screenshots | visual truth, desktop + mobile |

Always prefer the source closest to the customer for quality claims, and the source
closest to the machine for process claims.

## Phase 1 — CREATE

Pick the next scenario from a **rotation of genuinely different types** (record which in
the state file so runs vary). Write a realistic request a real customer would make — not
a synthetic minimal one. Submit it through the real entry point (the UI composer, the
public API), not an internal shortcut. Record the identifiers you'll need to trace it
(run id, record id, timestamps).

## Phase 2 — OBSERVE (process health)

Poll on a sensible interval — and do other work between polls, don't idle. Watch for red
flags and *record them as issues rather than waiting them out*:

- status says running but the event stream is silent / heartbeat stale;
- the run ends while its last output promises more work (premature exit);
- errors or retries in the stream, truncation warnings, quality gates that silently
  didn't fire;
- anything the customer would experience as "it just stopped".

## Phase 3 — ANALYZE (output quality)

Judge the artifact with **mechanical checks first, judgment second**
(`references/quality-rubric.md`):

1. **Deterministic checks** — cheap, scriptable, zero-tolerance: request fidelity (every
   demanded element exists), dead links, placeholder text, structural invariants, broken
   assets. Grep and re-fetch; don't eyeball what a script can prove.
2. **Judgment rubric** — graded dimensions with evidence: does it serve the request as a
   whole, quality of copy/visuals/structure, internal-jargon leaks. LOOK at images and
   screenshots with the Read tool; don't trust metadata.
3. **Gate honesty** — if the product has its own quality gate/report, compare its verdict
   to what you observed. A gate that contradicts the real artifact is itself a
   high-severity finding.

## Phase 4 — EXERCISE the mutations

Run the mutation matrix for the product: every editing/updating tool or endpoint, one
probe each, ✓/✗ with evidence in the state file. Include: a natural-language edit, a
scoped edit, an add, a delete/reorder, an undo/revert, a conflict case (stale version —
must be rejected with a useful error), and one input with special characters (`$`,
quotes, regex metacharacters — a classic corruption class).

**The trap this matrix exists to catch:** the product says "Done!" while the output
silently never changed (or broke every subsequent build). ALWAYS re-fetch the real
output after each mutation — never trust the success message.

## Phase 5 — FIX (delegate to root-cause-fix, per issue)

Highest severity first:

1. Prove the root cause from the ground-truth sources — the line that errors is almost
   never the root.
2. Fix the CLASS at the root layer, never special-case the repro.
3. Regression test that fails on pre-fix code — verify by actually reverting
   (`git stash push -- <file>` → test fails → `git stash pop`). Only then say
   "fail-on-revert verified".
4. Gates: typecheck + affected tests + lints on edited files.
5. **Restart what doesn't hot-reload.** Know which watchers cover which packages; an
   engine edit invisible to a stale runner produces a false "fix didn't work".
6. Update the ledger entry to FIXED with evidence, tests, and files touched.

## Phase 6 — ITERATE / STOP

- Re-run the exact operation that exposed each fixed defect against the fixed code —
  a unit test alone is not proof the live path recovered.
- Next scenario from the rotation until the budget is spent.
- **Stop when:** budget spent, OR a full scenario + mutation matrix passes with zero new
  high-severity findings (that's success, not an anticlimax). Then: full gates, hand
  shippable fixes to a fresh-context `reviewer` subagent with the diff + contract, and
  write the closing summary in the state file — fixed / open / deliberately-left, with
  evidence for each.
- **Compound:** append every NEW failure mode to the scenario matrix and rubric so the
  next cycle checks it automatically.

## Guardrails

- **Never touch real external systems** from this loop — no publishing to live CMS/site,
  no production writes, no real customer notifications. Test conversion/publish layers
  offline. List the forbidden operations explicitly in the state file.
- **Real spend is real.** LLM/API keys in dev are usually live: size the matrix
  accordingly (a handful of generations per cycle, not dozens).
- **Model-variance vs code-defect:** output that is merely *mediocre* from a generative
  step is a model/prompt issue (log it, don't patch it with brittle post-processing);
  output that is *structurally wrong or lost* is a code defect (fix it).
- Git: edits stay unstaged; no commit/branch/push unless asked.

## Pairs with

- skills: `agentic-loop` (loop discipline), `root-cause-fix` (the fix engine),
  `reviewing-ui` (UI findings surfaced here get logged there, not fixed ad hoc),
  `writing-tests`
- rules: `regression-test`, `no-shortcuts`, `definition-of-done`, `ui-evidence`
- agents: `reviewer` (maker-checker on the fix diff), `explorer`
- workflows: `run-quality-loop`
- templates: `state-file`
