---
"@buildinternet/uploads": minor
---

`uploads attach --branch [name]` and `uploads screenshot --branch [name]` stage files against a git branch before a pull request exists — for coding agents working a branch that hasn't opened a PR yet. Keys land under `gh/<owner>/<repo>/branch/<branch>/<filename>` with `gh.repo`/`gh.kind=branch`/`gh.branch`/`gh.staged-at` metadata; no managed comment is created since there's no PR/issue to comment on yet.
