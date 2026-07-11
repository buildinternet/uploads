# @buildinternet/uploads

## 0.2.0

### Minor Changes

- 0a0db13: Add `uploads install` to register the agent skill and the hosted remote MCP server in one step. Prefer `agents.uploads.sh` (workspace inferred from the bearer token); `mcp.uploads.sh` remains an alternate hostname.
- 0a0db13: Add `uploads mcp` — a stdio MCP server whose tools mirror the CLI (`put`, `attach`, `list`, `delete`, `comment`, `health`, `doctor`, and later usage tools) under the same config resolution, with an optional per-call `workspace` override.
- 0a0db13: Add workspace usage maintenance surfaces for agents and the CLI: `uploads usage`, `uploads reconcile`, and `uploads purge-expired` (plus matching MCP tools and a usage line on `uploads doctor`). Surfaces storage counters, optional budget remaining, ledger rebuild from storage, and retention purge when configured on the workspace.
