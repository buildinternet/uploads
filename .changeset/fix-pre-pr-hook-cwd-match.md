---
"@buildinternet/uploads": patch
---

`uploads hook pre-pr-screenshot` now fires only when the shell command actually runs `gh pr create` (not when the text appears in a quoted argument, like a `grep`), and it reads the branch and diff from the `cwd` in the hook payload instead of the hook process's own directory, so worktree sessions report the right branch.
