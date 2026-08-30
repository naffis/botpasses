# External practices: what high-performing AI teams ship

> Research input for the asset harvest. This captures how leading teams —
> primarily **Anthropic** and **Cursor**, plus the community ecosystem — author and
> distribute skills and rules, distilled into conventions loadout should adopt and a
> concrete candidate asset set to fold into the harvest review.
>
> Sources are cited inline. The two most authoritative primary sources are Anthropic's
> [Claude Code best practices](https://code.claude.com/docs/en/best-practices) and
> [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices),
> and Cursor's [Rules docs](https://cursor.com/docs/rules). The
> [Cursor Team Kit](https://github.com/cursor/cursor-team-kit) is a direct example of what
> Cursor itself ships.

---

## 1. The big picture: everyone converged on the same shape

Across Anthropic, Cursor, Codex, and the Loop Engineering methodology
(`docs/loop-engineering.md`), the building blocks are the same and load differently:

| Layer                    | Anthropic (Claude Code)                               | Cursor                                                        | loadout layer   |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------------------- | --------------- |
| Always-on project policy | `CLAUDE.md` (loaded every session, kept short)        | `AGENTS.md` + always-apply `.mdc`                             | baseline / rule |
| Scoped constraints       | (none native; CLAUDE.md imports)                      | `.mdc` rules: Always / Auto-attach / Agent-requested / Manual | rule            |
| Invokable procedure      | `SKILL.md` skill (`.claude/skills/`)                  | `SKILL.md` skill (`.cursor/skills/`)                          | skill           |
| Repeatable command       | slash command / skill with `disable-model-invocation` | `/command`                                                    | command         |
| Delegated sub-task       | subagent (`.claude/agents/`)                          | subagent (`.cursor/agents/`)                                  | agent           |
| External access          | MCP server                                            | MCP server                                                    | mcp             |
| Bundled distribution     | plugin + marketplace                                  | plugin / Remote Rules                                         | (layers A/B)    |

This is exactly loadout's layer map. The research **confirms** loadout's core
architecture; the value below is in the _authoring conventions_ and the _candidate content_.

---

## 2. Anthropic's conventions (the canonical rules)

### 2.1 `CLAUDE.md` — keep it short, it loads every time

From [Claude Code best practices](https://code.claude.com/docs/en/best-practices):

- Loaded at the start of **every** session, so only put things that apply broadly. For
  anything situational, use a **skill** (loaded on demand) instead.
- Litmus test per line: _"Would removing this cause Claude to make mistakes?"_ If not, cut it.
  A bloated `CLAUDE.md` makes Claude **ignore** instructions.
- Include: bash commands Claude can't guess, non-default code style, test instructions,
  repo etiquette, architecture decisions, env quirks, non-obvious gotchas.
- Exclude: anything inferable from code, standard conventions, detailed API docs (link
  instead), frequently-changing info, "write clean code" platitudes.
- Supports `@path` imports; can live at `~/.claude/`, project root, `CLAUDE.local.md`
  (gitignored), and nested dirs.

### 2.2 Skill authoring (the 500-line rule and friends)

From [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices):

- **Concise is key.** The context window is a public good; only add what Claude doesn't
  already know. Keep the `SKILL.md` body **under 500 lines**; split into reference files
  past that.
- **Progressive disclosure.** Metadata (name + description) is always pre-loaded; the body
  loads when triggered; reference files load only when needed. **Keep references one level
  deep** from `SKILL.md` (Claude partially reads deeply-nested files). Add a table of
  contents to reference files >100 lines.
- **Frontmatter contract:** `name` ≤64 chars, lowercase/numbers/hyphens only, no XML, no
  reserved words ("anthropic", "claude"); `description` non-empty, ≤1024 chars, **third
  person** ("Extracts…/Use when…", never "I can…"/"You can…"), with **both what it does and
  when to use it** plus key trigger terms (this is what drives selection among 100+ skills).
- **Naming:** prefer **gerund form** (`processing-pdfs`, `analyzing-spreadsheets`); avoid
  `helper`/`utils`/`tools`.
- **Degrees of freedom:** match specificity to fragility — high freedom (prose) when many
  approaches work; low freedom (exact script, "do not modify") for fragile/destructive ops.
- **Eval-driven:** build 3 evaluations _before_ writing docs; baseline without the skill,
  then write the minimum to pass. Develop with "Claude A authors, Claude B uses" iteration.
- **Scripts:** prefer pre-made utility scripts over generated code (reliable, token-cheap);
  handle errors instead of punting; no "voodoo constants"; forward-slash paths only.
- **Verifiable intermediate outputs:** plan → validate → execute for batch/destructive work.

### 2.3 Verification, subagents, and the agentic loop

From the best-practices guide (these are the highest-signal workflow patterns):

- **Give Claude a check it can run** (tests/build/lint/screenshot). It's the difference
  between a session you watch and one you walk away from. Escalating gates: in-prompt → a
  `/goal` condition re-checked each turn by a separate evaluator → a deterministic Stop hook
  → a verification subagent. **Show evidence, don't assert success.**
- **Explore → plan → code → commit.** Use plan mode to separate research from
  implementation; skip planning for one-sentence diffs.
- **Maker ≠ checker.** Use a fresh **subagent** to review the diff against the plan in a
  clean context ("report gaps, not style preferences"; over-zealous reviewers cause
  over-engineering). Writer/Reviewer across two sessions; tests-first by a second agent.
- **Subagents for investigation** keep the main context clean (context is the fundamental
  constraint).
- **Manage context aggressively:** `/clear` between unrelated tasks; after two failed
  corrections, clear and re-prompt; scope investigations or delegate them.
- **Hooks** are deterministic where CLAUDE.md is advisory ("must happen every time").
- **Scale:** non-interactive `claude -p` for CI/pipelines; parallel sessions via worktrees;
  fan-out loops over file lists with `--allowedTools` scoping.

### 2.4 Anthropic's own taxonomy of skills

Anthropic ships skills grouped as **document handling** (pdf/docx/xlsx/pptx),
**data fetching/analysis**, and **workflow** skills, plus a built-in **`skill-creator`**
(reuse it as the base for our `skill-author`) and a bundled **`/code-review`** skill that
reviews the current diff in a fresh subagent.

---

## 3. Cursor's conventions (rules, first-class)

From [Cursor Rules docs](https://cursor.com/docs/rules):

- **Four rule types**, set by frontmatter:

  | `alwaysApply` | `description` | `globs`  | Behavior                                                   |
  | ------------- | ------------- | -------- | ---------------------------------------------------------- |
  | `true`        | —             | —        | Always included (globs/description ignored)                |
  | `false`       | —             | provided | Auto-attached when a matching file is in context           |
  | `false`       | provided      | omitted  | Agent pulls it in when relevant (needs a good description) |
  | `false`       | omitted       | omitted  | Manual only, via `@`-mention                               |

- **Best practices:** keep rules **under 500 lines**; split large rules into composable
  ones; **reference files (`@file`) instead of pasting** (prevents staleness); write like
  clear internal docs; reuse instead of re-prompting.
- **What to avoid:** copying whole style guides (use a linter — the agent knows common
  conventions); documenting every command; edge-case instructions; duplicating code that
  exists (point to canonical examples). _Start simple; add a rule only when the agent
  repeats a mistake._
- **Tiers & precedence:** Team Rules → Project Rules → User Rules (merged; earlier wins on
  conflict). **AGENTS.md** is the plain-markdown alternative, supported nested per-directory
  with more-specific taking precedence.
- **Remote Rules:** import `.mdc` from any GitHub repo; auto-sync. (This is loadout's Layer B
  distribution mechanism.)
- `.md` files in `.cursor/rules` are **ignored** — project rules must be `.mdc` with
  frontmatter; use `AGENTS.md` for plain markdown.

### 3.1 What Cursor ships in the Team Kit

The [Cursor Team Kit](https://github.com/cursor/cursor-team-kit) (CI/review/shipping
workflows, "plug and play, no third-party services") ships **18 skills, 2 rules, 2 agents**:

- **Skills:** `loop-on-ci`, `review-and-ship`, `pr-review-canvas`, `verify-this`,
  `control-cli`, `control-ui`, `make-pr-easy-to-review`, `run-smoke-tests`, `fix-ci`,
  `new-branch-and-pr`, `get-pr-comments`, `check-compiler-errors`, `what-did-i-get-done`,
  `weekly-review`, `fix-merge-conflicts`, `deslop`, `workflow-from-chats`,
  `thermo-nuclear-code-quality-review`.
- **Agents:** `ci-watcher`, `thermo-nuclear-code-quality-review`.
- **Rules:** `typescript-exhaustive-switch`, `no-inline-imports`.

Notable shape: each skill is a tight `SKILL.md` with `## Trigger`, `## Workflow` (numbered),
`## Suggested Checks` (copy-paste commands), and `## Guardrails`. This is a good house style
for loadout skills.

---

## 4. The community ecosystem (breadth check)

- **Subagent taxonomy** ([VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents),
  100+ agents) groups specialists into: core-development, language-specialists,
  infrastructure, quality & security, data & AI, developer-experience, specialized-domains,
  business & product, meta & orchestration, research & analysis. Useful as a checklist of
  agent roles worth having.
- Curated skill indexes: [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills),
  [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code),
  [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills) (cross-tool).
- Public vendor skill packs (Vercel, Stripe, Cloudflare, Clerk, Resend, Supabase, Webflow,
  Notion, Hugging Face) show the **plugin-of-skills** model in production and are good
  structural references — not content to copy.
- **Caveat (inbound trust):** community skills are an injection surface. Treat
  collections as inspiration for _what_ to build, author our own, and run the `doctor`
  injection lint on anything pulled in.

---

## 5. How this reconciles with loadout

Mostly **confirmation** — the research validates the layer model, SKILL.md-as-unit,
plugin=shipping, skills-vs-MCP, native rails, and the maker/checker + verification-gate
patterns already folded in from the Loop Engineering pass. New, concrete tightenings:

| #   | Change                                                                                                                                              | Where                  | Status                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------- |
| 1   | Adopt canonical **skill frontmatter rules** (gerund `name` ≤64/lowercase-hyphen/no reserved words; third-person `description` ≤1024 with what+when) | `skill-author`, doctor | **done** (doctor)                  |
| 2   | Enforce the **500-line `SKILL.md` body** rule and **one-level-deep references** as the size guidance (replaces the vague soft limit)                | `skill-author`, doctor | **done** (doctor warns >500 lines) |
| 3   | Adopt **CLAUDE.md hygiene** ("would removing this cause a mistake?"; situational → skill) as a baseline/template convention                         | templates              | **later** (template)               |
| 4   | House style for skills: `## Trigger` / `## Workflow` / `## Suggested Checks` / `## Guardrails` (+ existing `## Pairs with`)                         | `skill-author`         | **later** (skill-author)           |
| 5   | Rules: enforce "reference files, don't paste"; "what to avoid" (no style-guide dumps, use a linter) as `rule-author` guidance                       | `rule-author`          | **later**                          |
| 6   | Seed a **verification/eval** convention (give a check; show evidence; plan→validate→execute; build evals first)                                     | workflows, runbooks    | **later**                          |

(Items 1–2 are implemented in `doctor` now; the rest are authored during the harvest.)

---

## 6. Candidate asset set (pre-build plan — SUPERSEDED)

> **This is the original brainstorm, not the shipped set.** Names here are provisional and
> some candidates were renamed, merged, or never built. The authoritative, current list of
> what actually ships is **`registry.json`** (and `docs/catalog.md`). Read this section as
> historical planning only.

These were **generalized, public-safe** candidates synthesized from the sources above.

### Skills (plugin: `core-engineering` unless noted)

| id (gerund where natural)            | What / when                                                     | pairs_with                 | workflows          |
| ------------------------------------ | --------------------------------------------------------------- | -------------------------- | ------------------ |
| `planning-a-change`                  | Explore → plan → implement → verify; use before multi-file work | base-conventions, reviewer | ship-a-feature     |
| `reviewing-and-shipping`             | Review branch, run tests, commit, open/update PR                | reviewer, commit-helper    | ship-a-feature     |
| `writing-commit-messages`            | Generate conventional commits from a diff                       | base-conventions           | ship-a-feature     |
| `opening-a-pr`                       | Fresh branch → work → PR with good description                  | make-pr-reviewable         | ship-a-feature     |
| `make-pr-reviewable`                 | Clean noisy history, add reviewer guidance                      | opening-a-pr               | ship-a-feature     |
| `fixing-ci`                          | Find failing checks, inspect logs, apply focused fixes          | ci-watcher                 | fix-ci-until-green |
| `looping-on-ci`                      | Watch CI and iterate until green                                | ci-watcher, fixing-ci      | fix-ci-until-green |
| `resolving-merge-conflicts`          | Resolve conflicts, validate build/tests                         | —                          | —                  |
| `verifying-a-claim`                  | Baseline/treatment artifacts → VERIFIED/NOT/INCONCLUSIVE        | reviewer                   | ship-a-feature     |
| `reviewing-a-diff` (subagent-backed) | Adversarial diff review in fresh context                        | reviewer                   | ship-a-feature     |
| `cutting-a-release`                  | Tag, changelog, release notes, publish                          | —                          | cut-a-release      |
| `migrating-a-schema`                 | Reversible up/down migration with validation                    | db-migration-safety        | ship-a-feature     |
| `deslopping`                         | Strip AI slop from a branch diff                                | base-conventions           | ship-a-feature     |
| `onboarding-to-a-codebase`           | Senior-engineer Q&A tour of an unfamiliar repo                  | —                          | onboard            |

### Meta skills (plugin: `meta`)

| id                    | What / when                                                                                                                                               |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill-author`        | Scaffold a SKILL.md to our conventions (frontmatter rules §2.2, progressive disclosure, house style, `Pairs with`); seeded from Anthropic `skill-creator` |
| `rule-author`         | Scaffold an `.mdc` rule (correct type/frontmatter, "reference don't paste", "what to avoid"); reminds when it should be a skill                           |
| `learning-from-chats` | Extract durable preferences from recent chats → skills/rules/AGENTS.md                                                                                    |

### Reporting skills (plugin: `reporting`)

`summarizing-my-work` (what-did-i-get-done), `weekly-review`.

### Rules (`.mdc`, flat in `rules/`)

| id                             | Type                  | Gist                                                             |
| ------------------------------ | --------------------- | ---------------------------------------------------------------- |
| `base-conventions`             | always (or AGENTS.md) | stack, voice, naming, do/don'ts — kept short                     |
| `verify-before-done`           | always                | always provide a check; show evidence; never ship unverified     |
| `context-hygiene`              | agent-requested       | `/clear` between tasks; scope/delegate investigations            |
| `claude-md-hygiene`            | agent-requested       | keep CLAUDE.md short; situational → skill                        |
| `commit-and-pr-etiquette`      | agent-requested       | branch naming, conventional commits, PR conventions              |
| `no-inline-imports`            | always                | (from team kit) imports at top                                   |
| `typescript-exhaustive-switch` | auto (`**/*.ts`)      | (from team kit) `never` default case                             |
| `no-secrets-in-code`           | always                | never hardcode secrets/keys; use env/secret store                |
| `audit-external-skills`        | agent-requested       | review third-party skills before install (inbound trust)         |
| `<stack>-conventions`          | auto by glob          | rails / workers / react — **project-specific; not shipped here** |

### Agents (subagents)

| id                  | Role                                                     |
| ------------------- | -------------------------------------------------------- |
| `reviewer`          | Maker/checker diff reviewer; "report gaps, not style"    |
| `security-reviewer` | Injection/authz/secret review; strong model, high effort |
| `explorer`          | Read-only codebase investigation, returns summaries      |
| `ci-watcher`        | Monitor CI, return concise pass/fail (from team kit)     |
| `code-quality`      | Strict maintainability rubric (thermo-nuclear style)     |

### Workflows (`processes/workflows/`)

| name                 | Composes                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `ship-a-feature`     | base-conventions + planning-a-change → reviewing-and-shipping → reviewer; gate=tests/lint |
| `fix-ci-until-green` | looping-on-ci + fixing-ci + ci-watcher; stop_condition=checks green                       |
| `cut-a-release`      | cutting-a-release + changelog command                                                     |
| `onboard`            | onboarding-to-a-codebase + explorer                                                       |

> Note: this section is the original pre-build candidate plan (provisional names). The
> actual shipped set is in `registry.json` and is **general-purpose only** — domain/vertical
> candidates (SMS/telephony, media/streaming, ML eval/training, MCP-tool authoring) were
> intentionally left out to keep loadout broadly reusable.

### Runbooks / templates (from Loop Engineering, per decision C2)

4-condition test, 30-second loop check, Ralph-Wiggum self-test, security-tax checklist;
`STATE.md` and automation starter templates.

---

## 7. 2026 Cursor addendum (flight family — 2026-08-17)

Surveyed again while hardening `do-it-right` / `deep-flight` / `post-flight`.
Newer models follow short contracts and **skim** 400-line self-graded checklists.
Adding more prose is the proximate patch. Class root: process as unenforced prose.

| Source                                                            | Takeaway we shipped                                                                                                                                                     |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cursor Skills](https://cursor.com/docs/skills)                   | Progressive disclosure; `scripts/` for mechanical receipts; `paths` / `disable-model-invocation`; keep SKILL.md lean                                                    |
| [Cursor Subagents](https://cursor.com/docs/subagents)             | Isolated context; official **verifier** pattern (`readonly: true`); put "use proactively" in the description so Agent auto-delegates                                    |
| [Cursor Agent Review](https://cursor.com/docs/agent/agent-review) | Native `/review` (Quick vs Deep) — do not reinvent as a `generalPurpose` Task                                                                                           |
| Cursor forum (skill scripts cwd)                                  | Scripts have **no pinned cwd**; `cd` to git root or use `BASH_SOURCE` for sibling assets                                                                                |
| Commands sunset (mid-2026)                                        | New workflows belong in skills (auto-invoke). Keep slash commands as thin wrappers. Do **not** set `disable-model-invocation` on flight gates — they must auto-trigger. |

Shipped assets: `deep-flight` + `deep-flight-rule` + `deep-flight-cmd` +
`flight-checker` + `_shared/scripts/shortcut-sweep.sh` + `_shared/flight-family.md`.
Same-day plan-build family: `plan-checker` + `plan-ban-sweep.sh` +
`_shared/plan-build-family.md` (create-plan / review-plan / complete-the-build /
review-build). See `docs/plan-build-family.md`.

Do **not** use `paths` on flight skills (they fire on conversation, not file
globs). Do **not** make the checker a same-session `Task generalPurpose`.

---

## 8. Sources

- Anthropic — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)
- Anthropic — [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- Anthropic — [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- Cursor — [Skills](https://cursor.com/docs/skills), [Subagents](https://cursor.com/docs/subagents) (verifier), [Agent Review](https://cursor.com/docs/agent/agent-review), [Rules](https://cursor.com/docs/rules), [Cursor Team Kit](https://github.com/cursor/cursor-team-kit)
- Community — [VoltAgent/awesome-claude-code-subagents](https://github.com/VoltAgent/awesome-claude-code-subagents), [ComposioHQ/awesome-claude-skills](https://github.com/ComposioHQ/awesome-claude-skills), [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code)
- `docs/loop-engineering.md` (Loop Engineering)
