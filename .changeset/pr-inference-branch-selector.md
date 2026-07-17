---
"@buildinternet/uploads": patch
---

Fix PR inference from the current branch: `gh pr view --repo` requires an explicit selector, so pass the current branch name. `uploads attach`/`put` from a branch with an open PR now resolve it instead of erroring.
