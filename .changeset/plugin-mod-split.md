---
"@uploads/plugin": minor
---

Split the Claude Code mod and pre-PR reminder hook into a separate `uploads-mod` plugin in the same marketplace, so the main `uploads` plugin is skills and the hosted MCP server only and can pass the Claude directory's checks. Existing installs that want the staged media band and reminder: `/plugin install uploads-mod@uploads`.
