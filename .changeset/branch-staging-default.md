---
"@buildinternet/uploads": minor
---

Bare `put` on a non-default git branch now stages to the branch prefix by default — same key and `gh.*` metadata as `attach --branch`, so it auto-attaches to that branch's PR when one opens. Only applies when none of `--pr`/`--issue`/`--key`/`--ref`/`--prefix`/`--destination` is set and `--no-git` isn't passed; the default branch, detached HEAD, not being in a git repo, `--no-git`, or any of those explicit flags keeps the classic dated layout. Prints a one-line staging note (same suppression as the existing bare-put nudge), and the stage-time binding warning from `attach --branch` now fires on this path too. Local stdio MCP `put` mirrors the same default.
