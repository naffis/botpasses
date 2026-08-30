# Loop state (template)

Persistent memory for a long-running or repeated workflow. The agent forgets between runs;
this file remembers. Keep it in the repo (or a tracker) so a resumed run picks up here.
Used by any workflow with a `state:` field and by the `automation-loop` template.

```json
{
  "loop_id": "<name>",
  "last_run": "<ISO-8601 timestamp>",
  "status": {
    "done": [],
    "in_progress": [],
    "blocked": []
  },
  "lessons_learned": [
    "<durable note that should survive across runs>"
  ]
}
```

Or as markdown:

## Done
- [x] <completed step / run id + outcome>

## In progress
- [ ] <current step> — <branch / run id> — <status>

## Next
- [ ] <next step>

## Lessons learned
- <gotcha discovered this run, so future runs don't repeat it>
