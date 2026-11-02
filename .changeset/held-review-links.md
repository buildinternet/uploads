---
"@buildinternet/uploads": patch
"@uploads/plugin": patch
---

`uploads staged --format json` adds `reviewUrl` to a held file when the server gives one: a 10-minute link for a workspace member to look at the file before approving. The Claude Code plugin uses it to draw the held image in the file's detail view, next to Approve.
