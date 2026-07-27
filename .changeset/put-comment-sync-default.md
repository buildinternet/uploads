---
"@buildinternet/uploads": minor
---

`put --pr`/`--issue` now syncs the managed attachments comment by default (same as `attach`), so uploads on a quiet PR show up without a webhook event or `--comment`. Opt out with `--no-comment`; `--comment` is kept as a no-op alias.
