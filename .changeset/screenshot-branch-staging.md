---
"@buildinternet/uploads": minor
---

`uploads screenshot` (CLI and local MCP) now stages against the current git branch by default when run on a non-default branch with no `--pr`/`--issue`/`--branch` target — same key and metadata as `attach --branch`, so derived facts (`path`/`url`/`env`/`viewport`, plus `--state`) survive through to the PR once it opens instead of being lost at attach time. Opt out with `--no-git`, or an explicit `--ref`/`--prefix`/`--destination`.

`attach` and `put --pr`/`put --issue` now print a `tip: add --meta path=/route so this shot is findable by page` (stderr, plus a JSON `hint` field) when an uploaded image ends up with no `path` metadata. Respects `--quiet`.
