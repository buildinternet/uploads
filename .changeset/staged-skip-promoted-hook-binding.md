---
"@buildinternet/uploads": patch
---

`uploads staged` and the `staged` MCP tool no longer list files that were already promoted to a pull request. The `gh pr create` reminder hook also ignores promoted files, and it now says staged files attach automatically when the repo is linked to this workspace (it keeps the `uploads attach --promote` advice when the link is missing or unknown, and says the files won't attach from here when the repo is linked to a different workspace).
