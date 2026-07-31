---
"@buildinternet/uploads": patch
---

`uploads doctor` now reports on bring-your-own-bucket storage status. Since
`GET /me/workspaces/:name/storage` requires a signed-in session and the CLI
only ever holds a workspace token, doctor honestly says it can't check
storage mode from the CLI today and points to the web settings page instead
of guessing.
