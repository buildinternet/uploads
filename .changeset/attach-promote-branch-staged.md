---
"@buildinternet/uploads": minor
---

`uploads attach` now auto-promotes branch-staged attachments (`attach --branch`) into a PR's attachment prefix the first time you attach to that PR, before refreshing the managed comment — no extra step needed once a PR opens for a branch you staged files against. Use `uploads attach --promote` (no file arguments) to promote and refresh the comment without uploading anything new, or `--no-promote` to opt out of the automatic behavior. Promotion talks to a new server endpoint and degrades silently (never fails the attach) when that endpoint isn't available yet.
