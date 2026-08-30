---
name: session-handoff
description: >
  Write or resume a durable session handoff packet so a fresh chat can continue
  without cold-start archaeology. Captures goal, done-condition, accomplished
  evidence, open gaps, failed attempts, locked decisions, and the exact next
  step under `.cursor/handoffs/`. Use when the user says "write a handoff",
  "session handoff", "hand off this work", "leave a handoff", "resume the
  handoff", "continue from handoff", "pick up where we left off", "context is
  full — hand off", or a long task will outlive the window. Anti-triggers:
  standup / what did I ship → summarizing-my-work; weekly recap → weekly-review;
  plan exhaustion → complete-the-build; session wrap → reviewing-and-shipping.
---

# Session handoff

Long agent sessions rot. The next context has no memory. A handoff is a
**repo-local packet** a zero-context agent can load and continue from — not a
status report for humans (`summarizing-my-work`).

Two modes: **write** (end of session / before context dies) and **resume**
(start of a fresh chat).

## Trigger

- Write: ending a multi-step task, switching topics, context filling, user asks
  for a handoff.
- Resume: "continue from handoff", "resume the handoff", paste/path to a file.

## Mode A — Write handoff

### 1. Collect ground truth (not memory)

```bash
git status --porcelain
git diff --stat
git log -5 --oneline
```

Re-read open todos, the active plan path, and any failing command output from
this session.

### 2. Write the packet

Default path: `.cursor/handoffs/<YYYY-MM-DD>-<short-slug>.md` (local; treat as
untracked / gitignored — do not commit unless asked).  
Shared / durable alternate: `docs/dev/handoffs/` only when the user wants a
committed packet for another machine.

Use the template in `references/handoff-template.md`. Required sections:

| Section               | Content                                                    |
| --------------------- | ---------------------------------------------------------- |
| Goal / done-condition | Verifiable end state                                       |
| Accomplished          | Files + behaviors with evidence                            |
| In progress           | Exact next unit of work                                    |
| Open gaps             | Partial/Missing/Punted (or "none")                         |
| Failed attempts       | Commands/errors so the next agent does not repeat them     |
| Decisions locked      | Mini-ADRs / plan pointers — do not reopen without evidence |
| Verification          | Gates run + outcomes (or "not yet")                        |
| Next step             | One concrete first action for the resume agent             |
| Constraints           | git-safety, no-shortcuts, branch, secrets                  |

### 3. Confirm

Reply with the file path and the **Next step** line only (plus blockers). Do not
re-narrate the whole session.

## Mode B — Resume handoff

1. Locate the packet (user path, or newest `.cursor/handoffs/*.md` /
   `docs/dev/handoffs/*.md`).
2. Read it end-to-end.
3. **Drift check** against live repo:

```bash
git status --porcelain
git diff --stat
```

Report: matches handoff / diverged (list how) / blocked.

4. Restate Goal + Next step. **Ask what to do next** — do not auto-execute a
   large plan unless the user says continue/implement.
5. When continuing, mark the handoff header `status: resumed` + timestamp, or
   append a short "Resumed" note — then do the Next step.

## Guardrails

- Evidence over recall — every "accomplished" row needs a path or command.
- No secrets/PII in the handoff (redact tokens, `.env` values, customer data).
- Do not invent remaining work; open gaps come from plan/todos/diff.
- Handoff ≠ commit. Leave edits unstaged unless asked to commit.
- Prefer a fresh chat after writing a handoff for the next phase of work.

## Never do

- Dump the raw chat transcript as the handoff
- Resume and immediately rewrite architecture decided in the packet
- Claim "nothing left" when the packet lists open gaps

## Reference pointers

- `references/handoff-template.md` — full markdown template

## Pairs with

- skills: `complete-the-build`, `agentic-loop`, `create-plan`,
  `summarizing-my-work` (different job)
- rules: `git-safety`, `no-shortcuts`, `shared-working-tree`
- commands: `session-handoff` (`/session-handoff`) — registry id `session-handoff-cmd`
- workflows: `plan-then-build`, `run-autonomous-loop`
