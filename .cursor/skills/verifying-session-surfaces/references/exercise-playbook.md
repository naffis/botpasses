# Exercise playbook

## Table of Contents

- [Oracle](#oracle)
- [Claim shape](#claim-shape)
- [Start the stack](#start-the-stack)
- [Per-layer how](#per-layer-how)
- [Protected surfaces](#protected-surfaces)
- [Failure paths](#failure-paths)
- [Cost and environment](#cost-and-environment)
- [After a fix](#after-a-fix)

## Oracle

Rank oracles; higher wins when they disagree:

1. What the user or caller observes on the live surface.
2. Deterministic project gates (typecheck, existing tests).
3. Tests authored in this same session — run them, do not trust them
   alone (circular validation: the maker wrote the assertion).

A claim is `WORKS` only when (1) is captured **or** the surface is
provably not user-reachable and (2) is green with the reason for
skipping (1) written down.

## Claim shape

Falsifiable, one sentence:

- Condition (auth, flag, fixture, viewport).
- Action (click, `curl`, CLI argv, MCP tool args).
- Observable (status, DOM text, file written, job row, error class).
- Threshold when it matters (`200`, "button enabled", "≤2s").

`VERIFIED` / `WORKS` means the treatment matches the claim with no
obvious confound (wrong port, stale stack, other agent's fixture).

Redact `Authorization`, cookies, API keys, and PII from pasted
transcripts.

## Start the stack

If a claim needs HTTP, a browser, a worker, or a DB:

1. Read the project's start command (`AGENTS.md`, README, `package.json`).
2. Check listeners. If down, **start** it; wait for the documented
   health URL.
3. Confirm one process per port (duplicates cause phantom failures).
4. Only then exercise. `BLOCKED` is legal after a failed start (quote
   the command + error). `BLOCKED` without a start attempt is a skip.

## Per-layer how

Use the repo's existing harness first (Playwright, browser MCP, `pnpm`
script, OpenAPI client). Invent a one-off harness only when none exists.

### UI

Follow `reviewing-ui/references/ui-evidence.md` and `ui-evidence`:

1. Markup / a11y snapshot (cheap).
2. Screenshot at the decision point (look at it).
3. Drive the real control; re-snapshot after the mutation.

Never inject localStorage, plant DB rows, or call the API to "reach"
the screen you were asked to exercise through the UI. Desktop + one
narrow width when layout changed. Console / network errors are
findings even when the pixels look fine.

### API

Hit the real local/dev origin the app uses. Quote method, path, status,
and the response fields the claim named. Cover authz: anonymous or
wrong-org must fail closed if the change is on a protected route.
Do not treat OpenAPI text as proof the handler runs.

### CLI / TUI

Run the installed or `pnpm exec` entry the user would run. Paste the
full command and the transcript. For interactive TUIs, prefer the
repo's harness; otherwise a short scripted argv path + `--help` is
the floor, and `BLOCKED` if the only path is a human TTY.

### MCP / agent tools

Invoke the tool through the same dispatcher the product uses (MCP
session or host executor). Quote tool name, args, and the result
shape. A unit test of the Zod schema is not a tool call.

### Jobs / crons / webhooks

Fire the trigger the runner would (HTTP webhook, `inngest` send,
manual enqueue). Confirm the side effect (row, file, downstream
call) — not only "handler returned."

### Flags

Exercise the session's intended default. If the change added a
flag, also prove flag-off is byte-identical or the documented
degrade — do not only test flag-on.

### Schema

Migrate (or dry-run) with the project's command, then exercise the
**consumer** (API/UI) that reads the new column. A green migration
test alone does not prove the product reads the field.

### Realtime (WS / SSE)

Perform the real upgrade or EventSource the client uses (ticket URL,
cookie, or Bearer — whichever the product ships). Confirm an event
arrives, or that an unauthorized upgrade fails closed. A unit test of
the HMAC helper is not a socket.

## Protected surfaces

If the session touched auth, tenancy, CSRF, or billing:

| Probe                    | Expect                          |
| ------------------------ | ------------------------------- |
| anonymous / no cookie    | 401/403 or the documented login |
| wrong org / other tenant | fail closed (no leak)           |
| happy auth               | the new behavior                |

Skip only when the change is explicitly public. Quote status codes.

## Failure paths

When the session added validation, empty states, or error copy, one
claim must be the closed path: empty submit, too-long value, wrong
id, expired token. Watch what the user sees, not only the thrown
Error class.

## Cost and environment

- Local or documented dev origin only. Production URLs are out of
  scope unless the user named them.
- Do not enqueue GPU / partner / paid generations to "prove" a
  compose or chat surface. Prefer a dry-run, preflight, or cheap
  health path. If the only honest proof is a paid run, ask first or
  mark `BLOCKED` (cost).
- Destructive actions (delete, refund, send-email): use a disposable
  fixture; say what you will mutate before doing it.

## After a fix

Re-run the **same command / same click** that produced BROKEN.
A different, easier probe is a new claim — it does not close the
old one. If the stack serves stale isolates after a code fix,
restart the owning process before re-exercise (note that in the
row).
