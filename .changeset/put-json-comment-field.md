---
"@buildinternet/uploads": patch
---

`put <file> --pr/--issue --format json` now includes `comment`/`commentError` in the single-file JSON payload, matching the multi-file batch shape (#541).
