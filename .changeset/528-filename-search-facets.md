---
"@buildinternet/uploads": minor
---

Filename search and metadata facet discovery on the token-authed API, CLI, and both MCP tool sets (issue #528).

`uploads find` / `list` accept `--name <term>` (and a bare name on `find`) for case-insensitive substring matching on object keys, alone or with meta filters. `uploads meta keys` and `uploads meta values <key>` expose the workspace's actual metadata vocabulary. The stdio and hosted MCP tools mirror this with optional `name` on `find_files` and a new `list_metadata_keys` tool.
