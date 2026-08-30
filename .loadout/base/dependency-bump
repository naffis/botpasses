---
name: dependency-bump
uses:
  rules: [lockfile-conflicts, dependency-version-management, no-shortcuts, regression-test]
  skills: [reviewing-dependencies, researching-a-dependency, fixing-ci, writing-tests, reviewing-and-shipping]
  agents: [ci-watcher, reviewer]
gate: "lockfile regenerated (not hand-merged); project typecheck + test + lint green; affected paths exercised for non-patch bumps"
stop_condition: "scoped bumps applied with changelogs reviewed, call sites updated for breaking changes, gate green, reviewer SAFE — or deferred/rejected with reasons"
state: ".loadout/state/dependency-bump.md"
---

# Dependency bump

Audit or land dependency upgrades without hand-merging lockfiles or rubber-stamping majors.
Use for a scheduled outdated report, a Dependabot/Renovate PR, or a deliberate version bump.
Security advisories first; majors one at a time.

1. **Scope** — list the packages and current → target versions in the state file. Split a
   multi-package PR if any single package is high-risk or major. Respect the project's
   version manager (`dependency-version-management`); don't switch runtimes unasked.
2. **Triage** — `reviewing-dependencies`:
   - Security / advisory fixes → first.
   - Patch → low risk, batchable.
   - Minor → medium; skim release notes.
   - Major → high; treat individually.
3. **Read the delta** — for every non-patch bump, read changelog/release notes between
   versions for breaking changes and deprecations. For majors or unfamiliar APIs, run
   `researching-a-dependency` against **primary sources** and record the cited notes before
   editing call sites.
4. **Apply the bump correctly** — change the manifest, then **regenerate** the lockfile with
   the package manager. Never hand-edit or hand-merge lockfile conflict markers
   (`lockfile-conflicts`): resolve the manifest, delete the lockfile conflict, regenerate.
5. **Fix call sites** — update code for breaking changes; add or adjust tests for touched
   paths (`writing-tests`). Don't silence type errors with `any` / `@ts-ignore` to absorb a
   bump (`no-shortcuts`).
6. **Verify** — run the `gate` locally. For majors, exercise the affected user paths once
   beyond unit tests. If CI is involved, `ci-watcher` + `fixing-ci` until required checks
   are green — never disable a check to land the bump.
7. **Review** — dispatch `reviewer` on the bump diff with charge: breaking-change handling,
   lockfile legitimacy, and no unrelated drive-by edits. Large bumps that mix refactors fail
   this step — split them.
8. **Ship or reject** — `reviewing-and-shipping` if the user asked to land it. If notes show
   an unacceptable break or the fix is out of scope, **reject/defer** with a written reason
   in the state file rather than forcing a partial upgrade.

Never blanket-approve a major because tests passed. Never commit a hand-resolved lockfile.
Never bundle an unrelated feature with a dependency bump.
