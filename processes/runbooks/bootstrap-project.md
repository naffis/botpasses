# Bootstrap a project

Equip a new or under-harnessed repo with loadout without dumping the entire library on day
one. Work backwards from behaviour (`harness-setup`): each piece must earn its context cost.
This runbook is the first-day path; `harness-setup` and `harness-hooks` are the progression
after that.

**Agents:** if the user pasted the loadout repo and said *use this* / *update to latest*,
follow repo-root `INSTALL.md` (or `equipping-loadout`) instead of improvising from this
runbook. That path vendors `ship-a-feature` + its full `uses:` block, plus
`equipping-loadout`, `definition-of-done`, and `doc-install`. This runbook is the
slower, progressive human path (baselines first, fewer assets on day one).

## Preconditions

- You have a git repo (or are creating one) and permission to add files.
- You know whether the team uses **Cursor**, **Claude Code**, or both.
- Pin consumers to a loadout **release tag**, not floating `main`, once you care about
  reproducibility.

## Path A — vendor with the CLI (most projects)

1. **Init**
   ```bash
   cd your-project
   npx github:naffis/loadout init
   ```
   This detects Cursor/Claude, scaffolds dirs, installs the SessionStart notify hook, and
   writes `loadout.lock.json`.
2. **Baseline memory** — add the thin pilot's checklist, not a style encyclopedia:
   ```bash
   npx github:naffis/loadout add template-agents-md
   # If Claude Code is in play:
   npx github:naffis/loadout add template-claude-md
   ```
   Fill in stack, commands, conventions, and hard do-nots for *this* repo.
3. **Always-on rules (short list)** — start with constraints that prevent real damage:
   ```bash
   npx github:naffis/loadout add \
     no-shortcuts size-limits regression-test no-secrets-in-code definition-of-done
   ```
   Add language-specific auto-attached rules only when the stack matches (e.g. `no-any`,
   `no-floating-promises`, `typescript-exhaustive-switch` for TypeScript).
   Optional **shared trunk kit** when multiple agents share one local checkout (no per-agent
   branches/worktrees/stashes; commit-all on ask):
   ```bash
   npx github:naffis/loadout add \
     git-safety no-stash shared-working-tree committing-on-shared-trunk
   ```
   Name the integration trunk in `AGENTS.md`.
4. **Starter workflow kit** — seeds from `kits.starter`, then let `update` close `uses:`:
   ```bash
   npx github:naffis/loadout add \
     doc-install equipping-loadout \
     start getting-started \
     ship-a-feature plan-then-build \
     no-secrets-in-code definition-of-done
   npx github:naffis/loadout update
   ```
   That pulls `ship-a-feature` and `plan-then-build` plus each workflow's skills, commands,
   rules, and agents (including `/plan` → `/review-plan` → `/review-build`).
5. **Orient** — run the `onboard-to-codebase` workflow (or add it and ask the agent to follow
   it) so the first session learns architecture, change patterns, and gate commands.
6. **Doctor**
   ```bash
   npx github:naffis/loadout doctor
   ```
   Fix errors before declaring bootstrap done.
7. **First kickoff** — `/start` (Claude) or *"I want to build X — what should I do?"* so
   `getting-started` emits a paste-ready prompt with the real gate command.

## Path B — native distribution (less vendoring)

- **Claude Code:** `/plugin marketplace add naffis/loadout` then
  `/plugin install core-engineering@loadout` (and `meta` when authoring skills/rules).
- **Cursor rules:** Settings → Rules → Remote Rule (GitHub) → `https://github.com/naffis/loadout`
  pointed at `rules/`.
- Still vendor **workflows / runbooks / templates** you want in-repo via `loadout add`, or
  keep them as reference and paste kickoff prompts from `docs/catalog.md`.

## What not to install on day one

- Full hook suites — add from `harness-hooks` when a must-happen-every-time failure appears.
- Autonomous loops — pass `loop-preflight` and get a **manual** run reliable first.
- Every skill in the catalog — add when a workflow you actually run needs it. After adding a
  workflow, run `loadout update` so it installs that workflow's `uses:` block; do not binge
  the rest of the catalog.
- Domain/vertical plugins that aren't generalized — loadout intentionally omits them.

## Verify bootstrap

- [ ] `AGENTS.md` (and `CLAUDE.md` if needed) exist and name real commands
- [ ] `loadout.lock.json` present; `loadout doctor` clean (or warnings understood)
- [ ] Gate command known and runnable (`test` / `lint` / `typecheck`)
- [ ] One workflow chosen for the first task; kickoff prompt written
- [ ] No secrets in repo config; MCP additions audited (`audit-external-skills`) before trust

## Next rungs (after the first ship)

Follow `harness-setup`: MCP → hooks → subagents → planning/verification → loops →
self-improving (`hardening-the-harness`, `learning-from-chats`). Each rung is a response to
a felt failure mode, not a checklist to binge.
