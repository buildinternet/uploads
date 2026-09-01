---
"@buildinternet/uploads": minor
---

Follow branch renames when promoting staged uploads. The CLI reads `git branch -m` steps from the branch reflog and registers them with the server, so `attach --pr`, `attach --promote`, and files staged by `attach --branch`, `put`, or `screenshot` are still found after a rename. Promote output notes when a rename was followed. `--from-branch` remains the manual fallback for a branch renamed or deleted without a later `uploads` run.

The stdio MCP `attach` tool now matches the CLI: with `pr`, it promotes the current branch's staged files and reports `promotion`/`promoteError`, with new `fromBranch` and `noPromote` arguments.
