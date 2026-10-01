---
"@uploads/plugin": minor
---

Add a Claude Code mod to the Claude plugin. It shows the screenshots staged for the current branch above the prompt. After `gh pr create` opens a PR, it attaches them with `uploads attach --promote`, or reports that the uploads.sh GitHub App will. It needs Claude Code 2.1.287 or later; older versions skip it. An **Attach staged files on gh pr create** option turns off the automatic attach.
