---
"@buildinternet/uploads": patch
---

`uploads install` registers the hosted MCP server with Claude Code, Codex, and Grok independently. A CLI that is not installed is skipped instead of failing the MCP step, so the rest of the install still completes.
