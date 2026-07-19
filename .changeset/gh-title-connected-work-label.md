---
"@buildinternet/uploads": minor
---

`uploads attach` and `put --pr`/`--issue` now also stamp `gh.title` with the resolved PR/issue title (best-effort via local `gh`, never blocks the upload) so the connected-work label in the workspace rail can show the real title instead of the bare `owner/repo#123` ref.
