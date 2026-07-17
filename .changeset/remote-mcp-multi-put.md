---
"@buildinternet/uploads": minor
---

Export `mapBounded` from the `/mcp` entry so runtime-agnostic MCP tool sets (like the hosted worker's multi-file `put`) can share the SDK's bounded-concurrency batch helper.
