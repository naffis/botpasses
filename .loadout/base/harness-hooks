# Harness hooks: the enforcement layer

Hooks separate "I told the agent to do X" from "the system enforces X." Use a hook (not a
rule) when something must happen **every time, with zero exceptions**. See
`docs/agent-harness-engineering.md` for the why.

**Principle: success is silent, failures are verbose.** A passing check prints nothing; a
failing one writes the error so the agent reads it and self-corrects. Cheap in the common
case, actionable when it matters.

## Where hooks live

- **Cursor:** `.cursor/hooks.json` + scripts in `.cursor/hooks/`. Events include
  `afterFileEdit`.
- **Claude Code:** `.claude/settings.json` `hooks` (e.g. `PostToolUse`, `PreToolUse`,
  `Stop`, `SessionStart`) running shell commands.

The patterns below are tool-agnostic; wire them into whichever your project uses. Keep hook
scripts fast and idempotent — they run constantly.

## Pattern 1 — Auto-format on write (don't burn tokens on whitespace)

`.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "afterFileEdit": [{ "command": ".cursor/hooks/format.sh", "matcher": "Write|StrReplace|TabWrite" }]
  }
}
```

`.cursor/hooks/format.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
file_path=$(jq -r '.file_path // empty')   # hook payload arrives on stdin as JSON
[ -z "${file_path:-}" ] && exit 0
case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.md) npx --no-install prettier --write "$file_path" >/dev/null 2>&1 || true ;;
  *.rb) bundle exec rubocop -A "$file_path" >/dev/null 2>&1 || true ;;
  *.py) ruff format "$file_path" >/dev/null 2>&1 || true ;;
esac
```

## Pattern 2 — Post-edit typecheck/lint back-pressure (fail loud)

Run the project's fast check after an edit; on failure, emit the error so it re-enters the
loop. Keep it scoped/fast (typecheck or the touched file's lint), not the whole suite.

```bash
#!/usr/bin/env bash
# .cursor/hooks/post-edit-check.sh — non-zero exit + stderr surfaces the failure to the agent
set -uo pipefail
out=$(npm run -s typecheck 2>&1) || { echo "Typecheck failed:"; echo "$out"; exit 1; }
exit 0
```

## Pattern 3 — Block destructive commands (deterministic guardrail)

A `PreToolUse`/before-bash hook that refuses irreversible actions regardless of what the
prompt said:

```bash
#!/usr/bin/env bash
# reads the proposed command on stdin; exit non-zero to block
cmd=$(cat)
if printf '%s' "$cmd" | grep -Eiq 'rm -rf /|git push .*--force|git reset --hard|DROP TABLE|TRUNCATE'; then
  echo "Blocked destructive command. Ask a human to run it." >&2
  exit 1
fi
exit 0
```

## Pattern 4 — Require approval before push / PR / production

Gate the high-stakes actions behind an explicit human step rather than trusting the model
to remember. Block `git push` to `main`/`master` and `gh pr merge` in the hook; allow them
only when an env flag or interactive approval is set. (Pairs with the `commit-and-pr-conventions`
rule and your repo's git-safety policy.)

## What to enforce with a hook vs. a rule

- **Hook** (deterministic, must-happen): formatting, typecheck/lint/test gates, blocking
  destructive commands, approval gates, update notifications.
- **Rule** (advisory, shapes behaviour): conventions, style intent, "prefer X over Y."

If the agent keeps violating a rule, promote it to a hook. That promotion is the ratchet
(`harness-setup.md`).

## Guardrails

- Hooks run untrusted-ish automation on every action — keep them minimal, fast, and unable
  to leak secrets (no verbose logging of env).
- A hook that hangs stalls the agent; add timeouts and `|| true` for non-blocking steps.
- Don't make formatting hooks fail the turn; do make correctness gates fail loudly.
