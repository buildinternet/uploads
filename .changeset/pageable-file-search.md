---
"@buildinternet/uploads": minor
---

Page through file search: `findFiles` now returns an opaque `cursor` and
accepts one back, `findFilesAll` follows it up to a page cap, and `uploads
find` / `uploads list --meta` gained `--cursor` and `--all`. The `find_files`
MCP tool takes and returns the same cursor.
