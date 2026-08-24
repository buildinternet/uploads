---
"@buildinternet/uploads": minor
---

`list`/`listAll` now skip the server's per-key metadata hydration when the
caller didn't request `metadata: true`, instead of fetching it and throwing
it away.
