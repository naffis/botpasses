---
name: post-flight
description: >
  End-of-session review-and-FIX: ask vs ship, shortcut sweep, fix-correctness
  (class-kill not bandaid), sibling sweep (pattern self-validate; callers first;
  risk tiers), DoD, gates, then a fresh-context independent checker before CLEAN.
  Completes deferred work by default. Triggers: "post-flight", "run post-flight",
  "review everything we did", "make sure we didn't miss anything", "was the fix
  correct", "no bandaid post-flight", "check for similar issues", "sibling sweep",
  "final pass and fix". Anti-triggers: merge/PR critique → reviewing-code-quality;
  open plan phases → complete-the-build; plan-only stress-test → review-plan;
  single bug at session start → root-cause-fix; mid-fix "do it correctly" →
  do-it-right; mid-session course-correct → deep-flight; adversarial check of
  a finished build vs plan → review-build; live surfaces / "does it work" →
  verifying-session-surfaces.
---

# Post-Flight — Session Review, Fix, and Improve

You just finished (or believe you finished) a body of work in this session.
Prove it against evidence, not memory, and **fix** what the proof turns up.
This is fix-mode review: findings get repaired here (unlike a read-only critique).

Six iron rules:

1. **Evidence over recall.** Never assert "we did X" from conversation memory.
   Re-read the file, re-run the command, re-check the diff.
2. **Fix, don't defer.** A finding is fixed now or logged with a reason it cannot
   be fixed now. "Noted for later" without a log entry is a shortcut.
3. **Converge, don't churn.** Improvements must reduce risk or close a gap in
   what was ASKED. No drive-by refactors or scope invention (`refactor-discipline`).
4. **Root fix, not specimen green.** A change that makes _this_ case pass while
   the class still reproduces on a sibling path is a **P0** finding. Prefer
   class-kill at the owning layer (`references/fix-correctness-audit.md`).
5. **Hunt outside the diff.** For every behavioral class this session touched,
   deep-dive related code for the same shape — and fix confirmed siblings before
   CLEAN (`references/sibling-surface-sweep.md`).
6. **Maker ≠ sole checker.** Behavioral sessions need the isolated
   **`flight-checker`** (readonly) before CLEAN — not a `generalPurpose` Task
   fed the maker's rationale (`references/independent-checker.md`).
   Routing: `_shared/flight-family.md`.

## Trigger

Session wrap after substantive work. Prefer this over a chat-only summary when
the user says "post-flight" / "final pass and fix". Prefer `review-build` when
the ask is a fresh-chat adversarial grade against a written plan (not the maker
fixing their own session). Prefer `do-it-right` mid-diagnosis before a fix lands.

## Workflow

### Step 0 — Reconstruct the ground truth

1. Re-read the user's original request(s) **verbatim** — every message that
   added or changed scope.
2. List concrete deliverables those messages imply. Number them.
3. Artifact list from git, not memory:

```bash
git status --porcelain
git diff --stat
git diff --stat --staged
```

4. Unfinished or silently dropped todos are findings.
5. **Deferral inventory** — first-class work items, not footnotes:
   - "as a follow-up", "left for later", "deferred", "next step would be"
   - Todos still `pending` / `in_progress`
   - `TODO` / `FIXME` **introduced this session** (`git diff`)
   - Parking-lot / plan "Discovered Issues" added this session
   - Partial implementations with a note

### Step 1 — Requirements diff (asked vs shipped)

```
| # | Asked | Shipped? | Where | Verified how |
|---|-------|----------|-------|--------------|
| 1 | ...   | ✅ / ⚠️ partial / ❌ | path:symbol | test / command / read |
```

Inverse: anything shipped that was NOT asked? Justify in one line or revert.

### Step 2 — Adversarial re-read

For each session-owned changed file:

- Read the FULL current file — does the change cohere with surroundings?
- Find every caller/consumer (`Grep`). Did any need updating?
- Walk failure paths: empty input, throw, async reject, undefined fields.

### Step 3 — Shortcut sweep (mechanical)

```bash
.cursor/skills/_shared/scripts/shortcut-sweep.sh
```

Quote the `RECEIPT`. A sweep with no RECEIPT was skipped.

### Step 4 — Fix-correctness / root-depth audit

**Read `references/fix-correctness-audit.md`.** For every behavioral intent:

1. Classify (bug-fix vs feature vs docs/refactor skip).
2. Run the matching checklist (layer pin, counterfactual sibling, rejected
   proximate, consumer trace, regression lock — or feature contract variant).
3. Verdict: `class-kill` · `correct-feature` · `bandaid` · `wrong-layer` ·
   `unproven` · `n/a-docs` · `n/a-refactor`.
4. Any `bandaid` / `wrong-layer` / `unproven` is **P0** — escalate via
   `root-cause-fix`, then re-attest.

Emit the fix-correctness matrix into the final report (silence = skipped).

### Step 5 — Sibling / similar-issue surface sweep

**Read `references/sibling-surface-sweep.md`.** For every non-skipped Step 4 intent:

1. Risk tier A/B/C + recon scout.
2. Name class + mechanism + hunt keys.
3. **Pattern self-validation** against pre-fix code (or new invariant for features).
4. Hunt callers/entry points first; record query → hit count including zeros.
5. Read full functions on plausible hits; triage `same-class` / `partial-port` → fix now.
6. Zero siblings → write the **negative attestation** (tier + validated path).

### Step 6 — Definition-of-Done walk

Walk `definition-of-done` for rows this session triggers. Common misses:

- Regression test that fails when the fix is reverted
- Docs/changelog for user- or operator-visible changes
- Always-on docs (`AGENTS.md` / harness) when agent behavior changed
- Size limits — did a grandfathered file grow past soft limits?

### Step 7 — Ground-truth verification

Run what the project documents as the gate (`AGENTS.md` / CI / plan test plan)
for packages the diff actually touches. Paste real closing lines. Plus any
change-specific proof (script, route, UI). Claims without evidence are forbidden.

### Step 8 — Fix loop

- **P0** (broken behavior, security, bandaid/wrong-layer/unproven, same-class
  sibling): fix at the root; re-run Steps 4–7.
- **P1** (asked-but-missing, partial DoD, partial-port): fix now.
- **Deferred work:** **DO IT NOW by default.** Survivors need one of:
  1. Input only the user can give
  2. Genuine scope change needing approval
  3. Refactor-class item needing its own test net (`refactor-discipline`)
  4. External dependency (deploy, third-party, hardware)
- **P2:** fix if small and reduces risk; else log with rationale.
- **Out of scope:** log, don't expand the ask.

After fixing, re-run Steps 2–7 on the fixes (including fresh Step 4 + 5).

### Step 9 — Independent checker (fresh context)

**Read `references/independent-checker.md`.** Launch **`flight-checker`**
(`readonly: true`, no `resume`). A `generalPurpose` Task fed the maker's story
is not a checker. FAIL → fix once + one recheck max. Still failing →
**BLOCKED**. Docs-only → N/A with one line.

### Effort contract — skipped work must be visible

Every step emits a named artifact in the report. Missing artifact = not done:

1. Per-file audit table with exactly one row per session-owned changed file
2. Shortcut-sweep receipts (pattern → hit count, including 0)
3. Fix-correctness matrix (one row per behavioral intent)
4. Sibling-sweep artifacts (or negative attestation)
5. Checker receipt
6. Quoted command output
7. DoD row accounting (`triggered` / `not triggered`)

### Step 10 — Stop condition and report

Stop when: two consecutive maker passes with zero new P0/P1; Step 7 green;
Step 9 PASS (or docs-only N/A). Then report:

```markdown
## Post-flight report

**Verdict:** CLEAN / FIXED (N issues) / BLOCKED (needs user input)

### Requirements matrix

### Fix-correctness matrix

### Sibling / similar-issue sweep

### Independent checker

### Coverage accounting

### Per-file audit

### Found and fixed

### Deferred work completed

### Logged, not fixed

### Verification

### Tickets (if project syncs issues)
```

Leave edits unstaged unless the user asked to commit (`git-safety`).

### Step 11 — Ticket sync (optional)

If the project has an issue-tracker sync rule (e.g. Linear progress comments),
run its **progress** path with the verdict + what was fixed/verified. Skip when
the project has no such convention, or the change is trivial. Never invent
ticket IDs or touch unrelated teams.

## Guardrails / Never do

- Audit from memory; report without fixing; skip Step 4 or 5 on behavioral work
- Self-grade CLEAN without checker PASS (or docs-only N/A)
- Port a bandaid to more call sites instead of fixing the owning layer
- Absorb sibling-agent WIP on a shared dirty tree as your ask
- Re-defer inventory items without naming a survivor criterion (1–4)
- Declare clean on pass 1 (fixes are new attack surface)

## Pairs with

- skills: `do-it-right`, `deep-flight`, `root-cause-fix`, `agentic-loop`, `review-build`,
  `complete-the-build`, `reviewing-and-shipping`, `reviewing-code-quality`,
  `deslopping`, `simplifying-code`, `writing-tests`, `verifying-session-surfaces`
- rules: `no-shortcuts`, `definition-of-done`, `regression-test`,
  `refactor-discipline`, `git-safety`, `shared-working-tree`
- agents: `flight-checker`, `reviewer`
- commands: `post-flight-cmd` (`/post-flight`), `review-build-cmd` (`/review-build`),
  `do-it-right-cmd` (`/do-it-right`)
- workflows: `ship-a-feature`, `plan-then-build`, `run-autonomous-loop`,
  `debug-production`
- references: `fix-correctness-audit.md`, `sibling-surface-sweep.md`,
  `independent-checker.md`
