---
"@buildinternet/uploads": minor
---

`meta set` refreshes the managed PR/issue comment when it changes `path` or `state` on a `gh/…`-keyed attachment, so backfilled metadata shows up without waiting for the next attach. If the bot endpoint is unavailable it prints a `uploads comment` hint instead of failing the write. The server side also self-heals duplicate managed comments left by a create race: the oldest is kept and updated, extras are deleted on the next sync (issue #470).
