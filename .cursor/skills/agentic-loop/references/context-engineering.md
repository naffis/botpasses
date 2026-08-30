# Context engineering (managing your own attention budget)

Context is a **finite resource with diminishing returns**. Transformer attention is n^2 over
the window, and models develop *context rot* — as the window fills, recall and long-range
reasoning degrade. Every token spent on stale tool output, an irrelevant file, or a verbose
dump depletes the attention budget for what actually matters. The guiding principle: **find
the smallest set of high-signal tokens that maximizes the likelihood of the desired
outcome.** ("Minimal" != "short" — it means high-signal.)

This is meta-guidance for how *you* (the dev agent) use *your own* context on a task. It is
the difference between a loop that stays sharp over a long task and one that drifts, forgets
the goal, and re-derives the same facts.

## 1. Just-in-time retrieval over front-loading

Do **not** pre-load everything you *might* need. Keep lightweight identifiers — file paths,
symbol names, grep queries — and pull content in on demand.

- Locate with `Grep` (exact symbols/strings), `Glob` (file patterns), or semantic search
  (meaning-based, for unfamiliar areas). These return cheap pointers.
- `Read` only the few files you actually need, and prefer **line ranges** on large files over
  the whole file. Don't `Read` a 2,000-line file when a grep + a 40-line range answers the
  question.
- Folder names, file names, and timestamps are *signals*. `test_utils.py` in `tests/` means
  something different than in `src/core/`. Let the file system's structure guide retrieval
  instead of loading blobs.

**Trade-off:** runtime exploration is slower than having everything pre-loaded. For a narrow,
well-scoped task where you already know the 2-3 relevant files, just read them. JIT retrieval
pays off on larger / unfamiliar surfaces.

## 2. Compaction (summarize, then continue)

On a long task, when the window is filling with old reasoning, dead ends, and stale file
contents, **compact**: write a high-fidelity summary of the essential state and continue from
it. Keep:

- architectural decisions made and *why*,
- bugs / failures still open (and what you already ruled out — preserve mistakes so you don't
  repeat them),
- the files currently in play and the next unit of work.

Discard: raw tool outputs already acted on, superfluous intermediate reasoning, and file
contents you've finished with. When you sense drift on a long task, stop and restate the
compacted state (in a `TodoWrite` update or a scratch note) before the next action. This is
the single most reliable lever for long-horizon coherence.

## 3. Structured note-taking (memory outside the window)

The model forgets between context resets; the repo does not. Persist state where a *fresh*
context can read it:

- **`TodoWrite`** — in-task working memory. One item per unit of work, updated in real time.
  Your progress ledger across dozens of tool calls.
- **Durable files** for cross-session or very long work: a `STATE.md` (state-file template), a
  `docs/` plan, or the ticket. Tomorrow's fresh context reads the state file and resumes
  exactly where this one stopped.
- Write notes a *stranger* (or a future you with an empty window) could act on — not cryptic
  shorthand.

## 4. The anatomy of good context

- **Right altitude** for instructions: specific enough to guide, flexible enough to let the
  model use judgment. Avoid both brittle hard-coded step lists and vague hand-waving.
- **Curated examples over exhaustive rules.** A few diverse, canonical examples beat a laundry
  list of edge cases stuffed into the prompt.
- **Tools are context too.** A bloated, overlapping tool set wastes context and creates
  ambiguous "which tool?" decisions. (For a product's tools, see the `agent-tool-design`
  skill.)
- **Tool results are context you can shed.** Once you've acted on a tool result deep in the
  history, its raw payload is dead weight — summarize the takeaway and move on.

## 5. Isolate bulk exploration in sub-agents

The cleanest form of context management is to **not put the bulk in your window at all**. An
`explorer` (or `generalPurpose`) sub-agent can burn tens of thousands of tokens crawling the
codebase and return a 1-2k-token distilled summary. The detailed search context stays isolated
in the sub-agent; your window keeps only the conclusion. Use this for broad "how does X work
across the repo?" sweeps. See `subagents-and-parallelism.md`.

## Checklist (apply on any long-horizon task)

- [ ] Am I front-loading files I don't yet need? -> switch to JIT retrieval.
- [ ] Is my window filling with stale output? -> compact and continue from the summary.
- [ ] Is critical state only in my context (not on disk)? -> write it to `TodoWrite` / a
      durable file so a reset can't lose it.
- [ ] Am I about to `Read` a huge file whole? -> grep to the range instead.
- [ ] Is this a broad exploration? -> delegate to an `explorer` sub-agent for a summary.
- [ ] Preserved failures so I don't retry dead ends? -> note *why* each check failed.
