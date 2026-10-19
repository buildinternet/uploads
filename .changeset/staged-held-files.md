---
"@buildinternet/uploads": patch
"@uploads/plugin": patch
---

`uploads staged` marks files held for review (`held: true` in `--format json`, "held for review" in the human listing). The Claude Code mod draws a held file as a lock card instead of fetching its thumbnail, counts held files in the band, offers Approve in the pane's detail view, and says when files it attached on `gh pr create` are held.
