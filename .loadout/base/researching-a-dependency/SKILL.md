---
name: researching-a-dependency
description: >
  Research an unfamiliar API, library, service, or pattern from primary sources and distill it
  into an implementation-ready reference doc before integrating it. Use before adopting new tech,
  when integrating a third-party API/SDK, or when unknowns block a plan ("how does X work?",
  "integrate Y", "add support for Z", "research this before we build"). Produces a versioned,
  cited reference a future session can build from without re-researching. Anti-triggers: audit
  outdated deps / review a bump PR -> reviewing-dependencies; document code we already wrote ->
  updating-docs.
---

# Researching a dependency

Before adopting an unfamiliar API/library/service, research it from primary sources and distill
it into a reference precise enough that a coding agent (including a future you) can write working
code without re-researching. Output beats "I read the docs" — the artifact is the point.

## When to use

- The plan hit an **unknown**: a technology/API/pattern you must understand before building.
- Integrating a third-party API, SDK, or service you haven't used here.
- INTEGRATION/INVESTIGATION work in `running-a-dev-cycle`'s research phase.

Not for auditing already-installed dependency versions or reviewing a version-bump PR
(`reviewing-dependencies`), nor for documenting code you already wrote (`updating-docs`).

## Step 1 — scope the research

State it explicitly before searching:

- **Primary question** — the specific capability/integration you must understand.
- **Implementation context** — your stack + versions (read `package.json` /
  `requirements.txt` / `Cargo.toml` / equivalent so examples match reality).
- **Depth target** — `QUICK_REF` (cheat sheet), `INTEGRATION_GUIDE` (step-by-step with code),
  or `DEEP_DIVE` (architecture + failure modes).

## Step 2 — gather from primary sources (in order)

Prefer primary sources; use your web search/fetch tools (search first, then fetch the top
authoritative pages — if a dedicated web tool like firecrawl is installed, prefer it). Source
hierarchy:

1. **Official docs** — API references, SDK docs, specs. Go here first.
2. **Official examples / starter repos** — working code from the maintainer.
3. **Changelogs / release notes** — for version-specific behavior.
4. **Vetted community** — high-signal, recent SO answers; posts by maintainers.
5. **General community** — tutorials/forums; verify, and check the date.

Source rules: record every source's URL + access date; flag anything >12 months old as
`[STALE — verify]`; if two sources conflict, prefer the one closer to the official org and note
the conflict; if official docs are ambiguous, read the source and link the exact file.

## Step 3 — distill (raw research is not documentation)

Transform what you found: **extract** only what's needed to implement; **normalize** to your
project's terminology; **sequence** setup -> auth -> basic usage -> advanced -> errors ->
gotchas; **concretize** every concept with a code example in *your* stack (translate the docs'
language if needed); **annotate** `NOTE`/`WARNING`/`GOTCHA` for anything that confused you or
will bite later.

Capture, where relevant: identity (name/version/license/links), purpose, auth (method, env var
names, where to get keys), install, config options + defaults, core API with signatures +
examples, data models, error codes + handling, rate limits + backoff, pagination,
webhooks/events, how to test/mock, cost, gotchas, and alternatives considered.

## Step 4 — write the reference doc

Store it where your project keeps references (e.g. `docs/reference/…`). Use a consistent
template so it's machine-readable:

```markdown
# <Technology>

> One-line: what it is and why we use it.

| Field | Value |
|---|---|
| Official docs | <url> |
| Version | <version we use> |
| Last Verified | <YYYY-MM-DD> |
| Status | ACTIVE / EVALUATING / DEPRECATED |

## Quick start        # minimal working example in our stack
## Authentication     # method, env var names, where to get keys
## Core usage         # key operations with commented examples
## Data models        # request/response shapes
## Error handling     # code -> meaning -> what our code should do
## Rate limits        # limits + backoff
## Gotchas            # non-obvious behaviors + workarounds
## Testing            # how to mock/sandbox
## Sources            # every URL + access date
```

## Step 5 — verify before you rely on it

- Code examples use your actual stack/versions and are real, not pseudocode.
- Auth is complete: env var names match your `.env.example`; the token flow is step-by-step.
- At least the common error codes are documented with what to do.
- If you found **zero** gotchas, you didn't research deeply enough — look again.
- `Last Verified` is today; cite exact versions ("tested with vX.Y"), not "works with X".

## Freshness

Reference docs carry a `Last Verified` date. If it's >90 days old, re-verify versions, endpoints,
and auth before trusting it. Update the date and note what changed when you touch it. Prefer
updating an existing doc over creating a near-duplicate.

## Pairs with

- skills: `running-a-dev-cycle`, `updating-docs`, `writing-an-adr`, `reviewing-dependencies`
- rules: `documentation-updates`, `dependency-version-management`
- workflows: `dependency-bump`
- docs: `agentic-patterns`
