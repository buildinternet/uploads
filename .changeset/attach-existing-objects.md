---
"@buildinternet/uploads": minor
---

`uploads attach --pr <num> <key-or-url>...` now accepts already-uploaded objects, not just local paths: an argument that doesn't exist on disk but resolves as a workspace object key or an uploads.sh URL (storage host, embed host, or `/f/` page) is attached via a server-side copy instead of erroring `file not found`. The source's own derived metadata (`path`/`url`/`viewport`/`state`/…) rides along; `gh.repo`/`gh.kind`/`gh.number`/`gh.ref` are stamped fresh. Copy by default; `--move` deletes the source after a successful copy. A path that exists on disk always wins as a local file. The hosted MCP `promote` tool gained a matching `keys` argument alongside its existing branch-staged sweep.
