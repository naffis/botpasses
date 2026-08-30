# Installing loadout (agent contract)

**Agents: when the user points at `https://github.com/naffis/loadout` (or this repo) and says
"use this", "install it", "equip this project", "update to latest", or similar — execute the
matching flow below. Do not invent a different install path.**

If this file is not already in the **consumer** project, fetch it first:

`https://raw.githubusercontent.com/naffis/loadout/main/INSTALL.md`

(Prefer a release tag in that URL when the user pinned one, e.g. `.../loadout/v0.12.0/INSTALL.md`.)

Humans: same steps work if you run the commands yourself. Detail: [`docs/usage.md`](./docs/usage.md).
Progressive day-one path (slower, more deliberate): [`bootstrap-project`](./processes/runbooks/bootstrap-project.md).

Invokable skill mirror (once `meta` is installed): **`equipping-loadout`**.

---

## Scope

| Directory | Role |
|---|---|
| **Consumer project** (`cwd`) | Where you run `init` / `add` / `update` |
| **loadout source** (this repo) | Upstream only — do **not** treat a loadout checkout as the consumer unless the user explicitly wants to equip *this* repo |

Pin when you care about reproducibility:

```bash
npx github:naffis/loadout#<tag> <command>   # e.g. #v0.12.0
```

Floating `npx github:naffis/loadout` tracks the default branch.

---

## Detect tools

In the **consumer** project:

| Signal | Tool |
|---|---|
| `.cursor/` or `.cursor/rules/` exists | Cursor |
| `.claude/` or `CLAUDE.md` exists | Claude Code |
| Neither | Treat as **both** (CLI vendors for both) |

---

## Already equipped?

If `loadout.lock.json` exists and lists installed assets:

- **"Use this" / equip again** → do **not** re-vendor the whole starter blindly. Run
  `npx github:naffis/loadout list --installed`, report what's present, then either
  **Flow B** (refresh) or `add <id…>` for anything missing the user asked for.
- **"Update to latest"** → **Flow B**.

`init` is safe to re-run (idempotent scaffolding); full starter `add` is not a reset button.

---

## Flow A — "Use this" / install / equip

Goal: bootstrap the consumer and install a **starter** set (not the whole catalog). Prefer
native delivery where it exists; vendor the rest via CLI.

### 1. Bootstrap

```bash
cd <consumer-project>
npx github:naffis/loadout init
```

Creates dirs, `loadout.lock.json`, SessionStart update-notify hook (Claude), and `AGENTS.md`
from the template when absent.

### 2. Claude Code (if detected)

If you **are** Claude Code, run these; otherwise tell the user to:

```text
/plugin marketplace add naffis/loadout
/plugin install core-engineering@loadout
/plugin install meta@loadout
```

Claude skills/commands/agents come from the plugins. Still run CLI `add` below for
workflows, Cursor-side skill copies, rule projection into `CLAUDE.md`, and the install
contract file.

### 3. Cursor rules (if Cursor — one-time per machine)

You cannot click Settings. Ask the user once:

> Cursor → Settings → Rules and Commands → Remote Rule (GitHub) → paste
> `https://github.com/naffis/loadout` (path `rules/`). Rules auto-sync on push.

If they skip Remote Rules, the CLI still vendors rules into `.cursor/rules/`.

### 4. Vendor the starter set

Seed ids live in `registry.json` → `kits.starter`: routing (`start` / `getting-started`),
the install contract, `ship-a-feature`, `plan-then-build`, and always-on guards
(`no-secrets-in-code`, `definition-of-done`). Add the seeds, then run `update` so it
installs each workflow's full `uses:` block (skills, commands, rules, agents).

```bash
npx github:naffis/loadout add \
  doc-install equipping-loadout \
  start getting-started \
  ship-a-feature plan-then-build \
  no-secrets-in-code definition-of-done

npx github:naffis/loadout update
```

`update` closes `uses:` and backfills any starter seed still missing. Already-present
ids are skipped on `add` (use Flow B / `update` to refresh). Including rule ids via
`uses:` is safe even when Remote Rules are wired.

Do **not** bulk-install the catalog. More assets: `npx github:naffis/loadout add <id…>` or
`loadout list` after the user asks. For a slower progressive equip, follow `bootstrap-project`.

**Optional — shared trunk kit** (parallel agents on one local checkout; no per-agent
branches/worktrees/stashes; commit-all when asked). Add when that is the project's model:

```bash
npx github:naffis/loadout add \
  git-safety no-stash shared-working-tree committing-on-shared-trunk
```

Name the integration trunk in `AGENTS.md`. This kit overrides worktree defaults in
`orchestrating-parallel-agents` / `clear-the-queue` / `build-as-graph` unless the user
explicitly asks for worktree isolation.

**Optional — task graph kit** (one nontrivial task as single-loop / pipeline / graph with
file allowlists + shared contracts). Add when you want structured fan-out inside a feature:

```bash
npx github:naffis/loadout add \
  build-as-graph task-topology decompose integrate \
  implement-node implement-node-rule agentic-loop \
  create-plan review-plan review-build writing-tests
```

Distinct from `clear-the-queue` (N tickets). Prefer with the shared trunk kit above when
that is the project's parallel-agent model.

**Security:** skills/rules are trusted instructions. Prefer a release tag when supply chain
matters; skim unfamiliar `SKILL.md` / `.mdc` first (`audit-external-skills`).

### 5. Report back

Summarize:

- Tools detected
- What ran (`init`, plugin install, CLI `add`)
- How to start work: **`/start`** or *"I want to build X — what should I do?"* (`getting-started`)
- How to refresh later: **"update loadout to latest"** (Flow B)
- Optional: Cursor Remote Rules still needed if they haven't done step 3

---

## Flow B — "Update to latest" / sync / refresh

Goal: pull upstream changes that are not yet local, **and** install anything the
current starter kit / installed workflows require that is still missing. Never
clobber without a merge trail.

### 1. Vendored assets (lockfile)

If `loadout.lock.json` exists:

```bash
# Dry run when they only asked "any updates?" / "what's new?"
# Reports both content updates and missing starter / uses: deps.
npx github:naffis/loadout update --check

# Apply: three-way merge managed assets + install missing kits.starter seeds
# and each installed workflow's uses: closure. Conflicts get markers, never
# silent overwrite. Use --refresh-only to skip installing missing assets.
npx github:naffis/loadout update
```

No lockfile / nothing vendored → say so and offer Flow A.

### 2. Claude Code plugins (if Claude)

```text
/plugin marketplace update
/plugin update core-engineering
/plugin update meta
```

### 3. Cursor Remote Rules

No CLI step — they auto-sync when configured. Say so if relevant.

### 4. Report back

- Updated / newly installed (missing) / already current / conflicts (paths; markers need a human resolve)
- Plugin update status (done vs user must run slash commands)
- Optional: `npx github:naffis/loadout list --installed`

---

## After install — invoke, don't re-explain

| Intent | What to do |
|---|---|
| Unsure how to start | `/start` or `getting-started` |
| Ship a known feature | Follow `ship-a-feature` (starter covers its `uses:`) |
| Plan → review → build | Needs the **`plan-then-build` kit** (or Claude plugins). Starter alone is not enough for `/plan` / `/review-plan` on Cursor — see `bootstrap-project` Path A step 4, or `add` that workflow's ids. With Claude plugins installed, `/plan` → `/review-plan` → implement → `/review-build` works. |
| Refresh loadout | Flow B / `equipping-loadout` |
| Browse everything | `npx github:naffis/loadout list` or `docs/catalog.md` |
