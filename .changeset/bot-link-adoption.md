---
"@buildinternet/uploads": minor
---

`.uploads.yml` gained an `adoptLinkedFiles` key (on by default for bound repos): when a PR body or comment references an uploads.sh file URL that was pasted in directly — rather than uploaded via `--pr`/`attach --branch` — the webhook now adopts it into that PR/issue's attachment context, so it gets pairing, dedupe, and screenshots-page grouping automatically. Only files already in the repo's own bound workspace are adopted; links to any other workspace's files are silently ignored. A lone adopted image with nothing else to consolidate doesn't trigger a managed comment on its own.
