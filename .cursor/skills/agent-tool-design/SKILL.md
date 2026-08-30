---
name: agent-tool-design
description: >
  How to design a product's agent-facing tools well — the ergonomics/quality of a tool surface
  an LLM orchestrator calls in a loop (function tools, MCP tools, executors). Applies the
  agent-computer-interface (ACI) principles: choosing what to build, namespacing, returning
  high-signal results, token efficiency, and steering descriptions/params/errors. Use when
  authoring or editing a tool's schema/description/params, shaping a tool's RESULT the
  orchestrator consumes, splitting/merging tools, or designing an MCP surface. Triggers on
  "tool description", "tool schema", "tool result shape", "design a tool for the agent", "why
  isn't the model calling this tool", "MCP tool ergonomics", "token-efficient tool response".
  Anti-trigger: the DEV agent's own task loop -> agentic-loop.
---

# Designing agent-facing tools

A tool is a contract between a **deterministic** system (your code) and a **non-deterministic**
agent (the orchestrator LLM). You are not writing an API for another developer — you are
writing an *agent-computer interface (ACI)*. Give a tool's name, description, params, and
**result shape** as much prompt-engineering attention as you'd give a system prompt: they load
into the orchestrator's context and steer its behavior on every turn.

This skill is the **quality/ergonomics** half. The **registration mechanics** half — how a tool
gets wired into your project (its registry/manifest, the executor, permissions/billing, docs
regeneration) — is project-specific; do both, and follow `capability-removal.mdc` when you
remove or merge tools.

## When to use

- Authoring a new tool, or editing an existing tool's name / description / input schema.
- Shaping the **result object** a tool returns (what fields, how verbose, what identifiers).
- Deciding whether to add a tool, merge tools, or split one — or why the orchestrator keeps
  mis-selecting.
- Working on an MCP manifest / external tool surface.

Anti-trigger: guidance for how the *development* agent runs its own task loop lives in
`agentic-loop`, not here.

## Principle 1 — choose the right tools (fewer, higher-signal)

More tools != better. A bloated or overlapping tool set wastes the orchestrator's context and
creates ambiguous "which tool?" decisions. The test: **if a careful human engineer can't say
which tool to use in a situation, the model can't either.**

- Build a few tools that map to **high-impact workflows**, not thin wrappers over every
  internal function or endpoint. A tool that returns "everything" forces the model to read it
  token-by-token (brute-force search).
- **Consolidate** frequently-chained steps into one tool. Prefer one call that does the common
  multi-step job over making the orchestrator invoke three primitives and stitch them. Prefer a
  `search_*` that returns only relevant lines over a `list_*`/`read_*` that dumps everything.
- Before adding a tool, ask: does an existing tool already cover this workflow? Overlap is the
  main cause of mis-selection. When removing/merging, follow `capability-removal.mdc`.

## Principle 2 — namespacing (clear boundaries)

With a large tool surface plus MCP servers, names are how the orchestrator navigates. Group
related tools under consistent prefixes reflecting natural task subdivisions
(`user_create`/`user_update`; `search_docs`/`search_code`). Distinct, non-overlapping names
reduce both the descriptions loaded into context and the chance of calling the wrong tool with
the wrong params.

## Principle 3 — return meaningful, high-signal context

The result object is context. Return what informs the orchestrator's *next* action; strip
low-level plumbing.

- **Semantic identifiers over cryptic ones.** Agents handle `name` / `path` / stable slugs far
  better than raw UUIDs / mime-types / opaque handles. Resolving arbitrary IDs to meaningful,
  interpretable strings measurably reduces hallucination in retrieval.
- **Prefer relevance over flexibility.** Don't return every field "just in case." If the
  orchestrator sometimes needs a verbose form, expose a `response_format`/verbosity enum
  (`"concise"` | `"detailed"`) so it can *choose*, rather than always paying for the verbose
  shape.
- **Result shape is a steering signal.** A tool that returns a machine-readable next-step hint
  (a suggested follow-up, an `action_required` nudge on a failed check) actively guides the
  loop. Design the result to make the *right* next move obvious.

## Principle 4 — token efficiency

Optimize the *quantity* of context a tool returns, not just its quality.

- Use pagination, range selection, filtering, and truncation with sensible defaults for
  anything that could be large.
- If you truncate, **steer**: tell the agent how to get more ("narrow the query", "page with
  cursor X"), don't just cut it off.
- Every result the orchestrator later acts on is shed-able context — keep the payload lean so
  the loop can run many turns without context rot.

## Principle 5 — prompt-engineer descriptions, params, and errors

- **Descriptions:** write for a capable new hire who lacks your implicit context. State the
  tool's distinct purpose, when to use it vs a sibling tool, input-format requirements, edge
  cases, and boundaries. Ambiguity here is the #1 cause of mis-use.
- **Params: poka-yoke.** Make wrong calls hard. Name `user_id` not `user`; require absolute
  paths if relative ones bite; use strict enums / a schema validator so an invalid input is
  impossible rather than silently wrong.
- **Errors that steer, not codes that stump.** A validation failure should say *what to fix*
  with a correctly-formatted example, not an opaque code or a raw traceback. A good error turns
  a dead-ended turn into a self-corrected one.
- **Semantic decisions belong to an LLM, not a regex.** If a tool's job is to classify meaning
  (intent, category), the tool calls a model — it does not keyword-match
  (`no-regex-for-semantics.mdc`). Regex is for fixed, finite syntax.

## Evaluation-driven iteration

You can't tell what's ergonomic by inspection — measure it. Run realistic multi-tool tasks and
read the transcripts:

- Watch where the orchestrator gets confused, calls the wrong tool, or supplies bad params.
  Read the *reasoning*, not just the outcome — what the model omits matters as much as what it
  says.
- Feed those mistakes back into the description/schema/result shape. Small description
  refinements yield outsized gains — treat a description as a tuned artifact, not documentation.

## Common pitfalls

- Wrapping an internal function 1:1 as a tool "because it exists" -> wastes context, adds a
  mis-selection risk. Build for the *workflow*, not the function.
- Returning raw UUIDs / mime-types / full records -> hallucination + token bloat. Return
  semantic, relevant fields.
- A description that assumes your implicit context -> the model can't infer what you didn't
  write. Spell out purpose, boundaries, and when-not-to-use.
- Opaque error strings -> the orchestrator can't self-correct; it burns turns or gives up.
- Adding the tool but skipping the wiring (registration/permissions/docs) -> it's ergonomic but
  unreachable, unpriced, or undocumented.

## Pairs with

- skills: `agentic-loop`
- rules: `no-regex-for-semantics`, `capability-removal`, `prompt-extraction`
- docs: `agentic-patterns`
