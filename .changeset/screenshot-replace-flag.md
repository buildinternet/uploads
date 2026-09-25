---
"@buildinternet/uploads": patch
---

`uploads screenshot --replace` and `UPLOADS_OVERWRITE=1` now overwrite an existing object at `--key`, matching `put`. The local MCP `screenshot` tool gains a `replace` argument, and the MCP `put` and `screenshot` tools now honor `UPLOADS_OVERWRITE=1`.
