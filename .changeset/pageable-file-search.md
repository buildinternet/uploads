---
"@buildinternet/uploads": minor
---

Page through file search. `findFiles` now returns an opaque `cursor` and
accepts one back. The new `findFilesAll` follows that cursor, up to a page cap.
`uploads find` and `uploads list --meta` gained `--cursor` and `--all`. The
`find_files` MCP tool takes and returns the same cursor.
