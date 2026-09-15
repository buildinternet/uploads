---
"@buildinternet/uploads": patch
---

Skip the stale "update available" hint after `uploads update`, and do not re-run `mcp add` (which can open a browser) when `mcp list` already shows the server.
