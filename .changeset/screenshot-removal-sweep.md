---
"@buildinternet/uploads": patch
---

Drop the leftover `--via remote` hint when no local browser is found, and remove the meaningless `browser.autoBackend` field from `uploads doctor --json`.
