---
"@buildinternet/uploads": patch
---

`uploads login` now says which auth host it is signing in to (with a self-hosting hint), includes the saved API URL in its success output and `--json` payload, and ends with a pointer to `uploads install` so agent users discover the skill + MCP setup command.
