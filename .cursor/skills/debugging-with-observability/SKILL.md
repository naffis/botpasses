---
name: debugging-with-observability
description: >
  Debug a production or staging issue from runtime evidence — logs, traces, metrics — before
  reading source. Use when a failure has no local repro: a failed/slow request or job, an
  intermittent error, a timeout, or "why did this fail in prod?". Get correlation ids, query the
  telemetry, interpret the signal, then hand a narrowed cause to debugging-an-issue /
  root-cause-fix. Triggers on "production error", "check the logs", "why did this fail", "it's
  slow in prod", "investigate the incident", "tail the logs", "trace this request".
  Anti-trigger: a bug you can already reproduce locally -> debugging-an-issue.
---

# Debugging with observability

For a runtime issue you can't reproduce locally, read the evidence before the source
(`observability-first`). Guessing at code without the signal wastes turns; the telemetry usually
names the failing component directly.

## When to use

- A request/job failed or was slow in production/staging and you can't repro it locally.
- An intermittent or environment-specific error.
- A timeout, rate-limit, or resource issue under real load.
- Any "why did this fail?" where the answer lives in runtime data, not the code alone.

If you can already reproduce the bug locally, skip this and use `debugging-an-issue`.

## Step 1 — get correlation ids

Every investigation needs an anchor. Find the id that ties the story together — a
request/trace id, a run/job id, a session/user id. Get it from the user's report, the URL, the
error tracker, or the platform's live view. Without an id you're reading noise; with one you can
follow a single request end to end.

## Step 2 — query the telemetry

Use whatever the project actually runs (application logs, an error tracker, an APM/tracing tool,
metrics, or a hosting platform's log query — some platforms expose these as MCP servers you can
query directly). In order:

1. **Discover the fields** if you don't know the schema — list the indexed keys/attributes.
2. **Find the failure** — filter to `level = error` (or the failure event) in the relevant time
   window and service.
3. **Trace the one request** — filter by the correlation id, sort by timestamp ascending, and
   read the full timeline (start -> steps/tool calls -> external calls -> completion or error).
4. **Quantify if it's performance** — for slowness, aggregate durations (p95/p99) grouped by
   operation/endpoint to find the actual slow step, not the assumed one.

## Step 3 — interpret the signal

Read the actual fields, don't pattern-match on the message alone:

- **Error shape** — the error name/type + the *body*. A 4xx almost always says what's wrong in
  the body; decode it before touching code.
- **Status codes** — `429` = rate limited (backoff / permit); `400` = bad request (read the
  body); `401/403` = auth/scope; `5xx` from a dependency = upstream, check its status.
- **Timeouts** — an abort/deadline fired: is the client timeout reasonable, and is the call
  retryable/idempotent?
- **Resource limits** — OOM / memory-exceeded / quota: look for unbounded accumulation (large
  payloads, growing arrays/caches) on that path.
- **Timing gaps** — in the traced timeline, the long gap between two events *is* the slow step.

Quote the exact log line / span that proves the cause — a runtime bug isn't understood until you
can point at the signal.

## Step 4 — turn up detail if needed

If the default signal is too coarse, raise the log level (or enable debug/tracing) for the
affected path, reproduce or wait for the next occurrence, then **turn it back down**. Prefer a
scoped, time-boxed increase over leaving verbose logging on (cost + noise + secret-leak risk).

## Step 5 — live tail (for an active issue)

For something happening now, tail the stream filtered to the correlation id or service and watch
it occur. Live tailing is for catching an active/repeating issue, not for historical analysis —
use the query path (Step 2) for the past.

## Step 6 — hand off

Observability narrows the problem to a component/call/error. Now:

- If you can turn it into a local repro -> `debugging-an-issue`.
- If it needs a proven, generalized fix -> `root-cause-fix` (the runtime signal is your Loop A
  evidence).
- Add or improve a structured log/metric on the failure path if the next debugger would
  otherwise be blind (`observability-first`): stable event name, the correlation id, no secrets.

## Guardrails

- Never log or paste secrets, tokens, or PII from telemetry into the diagnosis.
- Evidence over guessing: don't change code until a signal points at the cause.
- Turn temporary debug logging back off when done.

## Pairs with

- rules: `observability-first`, `no-secrets-in-code`, `regression-test`
- skills: `debugging-an-issue`, `root-cause-fix`, `fixing-ci`
- agents: `explorer`
- workflows: `debug-production`
- runbooks: `hotfix-and-rollback`
