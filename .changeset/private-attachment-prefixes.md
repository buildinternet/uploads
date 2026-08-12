---
"@buildinternet/uploads": minor
---

Private GitHub repos get randomized, unguessable attachment URL prefixes (#631). Public repos are unchanged. Requires no flags; applies automatically when the uploads GitHub App can see the repo is private. `uploads github rotate-prefix [--branch <b> | --repo-level]` rotates a prefix on demand, moving its attachments to a new URL and re-syncing the managed comment.
