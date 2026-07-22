---
"@buildinternet/uploads": minor
---

The managed attachments comment now shows a neutral empty state when every attachment and gallery is removed from a PR/issue. Deleting the last asset and re-running `uploads comment` (or a `put --comment`) rewrites the existing comment in place to "No attachments are currently associated with this pull request." — it is never deleted (a later upload repopulates it) and is never created just to say it is empty. `uploads comment` reports this as a "cleared" message rather than "updated (0 files)".
