---
description: Write or resume a durable session handoff for a fresh chat.
---

Run the `session-handoff` skill in full.

If the user is ending work or context is full → **write** a handoff to
`.cursor/handoffs/<date>-<slug>.md` (local; do not commit unless asked).
Use `docs/dev/handoffs/` only when the user wants a shared/committed packet.

If the user wants to continue → **resume** the newest (or named) handoff,
drift-check against git, restate Next step, and ask before large execution.

No secrets in the packet.

Focus / path: $ARGUMENTS
