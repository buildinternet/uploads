---
"@buildinternet/uploads": patch
---

Finish the session version sync before the CLI exits, so an expired login session is dropped after one 401 instead of being re-sent by every command.
