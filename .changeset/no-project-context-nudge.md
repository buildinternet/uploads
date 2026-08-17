---
"@buildinternet/uploads": minor
---

`put` and `screenshot` print an advisory stderr note when a path-tagged upload has no repo/app context and only a local origin — it would land in the screenshots page's "local dev" bucket. Suggests running from the project repo or passing `--app`. Suppressed by `--quiet`, `--no-git`, and the no-nudge config.
