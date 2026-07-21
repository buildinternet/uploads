---
"@buildinternet/uploads": patch
---

`uploads attach --branch <name>` now rejects a value that looks like a file
(an existing path on disk, or a name with a media/document extension like
`.png`/`.pdf`) instead of silently swallowing it as the branch name. Fixes
`uploads attach --branch shot.png` staging under a branch literally named
"shot.png" — use `uploads attach shot.png --branch` (auto-detect the current
branch) or `uploads attach --branch <name> shot.png` instead. Ordinary dotted
branch names like `v1.2` or `release/1.2` are unaffected.
