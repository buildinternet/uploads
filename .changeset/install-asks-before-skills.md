---
"@buildinternet/uploads": patch
---

`uploads install` now lists what it will set up (skills and the agents they go to, the MCP server, the hooks) and asks once before installing. Skills go only to the agents it found, and it prints where they went and how to remove them. `uploads install skill|mcp|hooks`, `--yes` and `uploads update` skip the question.
