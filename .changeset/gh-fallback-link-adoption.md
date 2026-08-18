---
"@buildinternet/uploads": minor
---

Link adoption (`adoptLinkedFiles`, issue #701) now also runs on the local-`gh` fallback comment path, not just the bot-managed one. `uploads comment --pr`/`--issue` (and the attach-time comment sync) scans the PR/issue body and comments for pasted uploads.sh URLs via local `gh` and adopts any that resolve to a file in the current workspace, before rendering the comment. Same semantics as the bot path: copy never move, additive metadata, idempotent re-adoption, no migration into private prefixes, and a lone adopted image with nothing else to consolidate doesn't trigger a fresh comment on its own (it still heals an existing one).
