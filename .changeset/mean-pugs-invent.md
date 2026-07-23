---
"@buildinternet/uploads": patch
---

`uploads comment` (and the `comment` MCP tool) now always hunts for the managed comment's marker instead of patching its cached comment id, so a duplicate comment left by a create race is collapsed on the next explicit resync rather than surviving until the id cache expires. Attach and screenshot syncs keep the cached-id fast path.
