---
description: Draft release notes / changelog entries from merged work since the last release.
---

Generate changelog entries for work since the last release tag.

1. Find the last release tag: `git describe --tags --abbrev=0` (fall back to the first commit if none).
2. List merged changes since then: `git log <tag>..HEAD --merges --first-parent` and the squashed commit subjects.
3. Group entries under **Added / Changed / Fixed / Deprecated / Removed / Security**.
4. Write user-facing, present-tense lines — what changed and why it matters, not commit hashes. Apply the `copy-voice` rule (no em-dashes, no filler).
5. Flag breaking changes and required migration/flag steps prominently.
6. Output the markdown block; do not edit files unless asked.
