---
"@buildinternet/uploads": patch
---

Mark the package `sideEffects: false` so Workers that import helpers from the main entry (e.g. the remote MCP worker) can tree-shake Node-only image code (`sharp` / optimize / frame) and deploy cleanly.
