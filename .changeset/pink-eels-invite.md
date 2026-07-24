---
"@buildinternet/uploads": patch
---

`uploads install` no longer reports an already-registered MCP server as a
failure. `claude mcp add` refuses to overwrite an existing entry and exits
non-zero, so re-running `install` (or `update`, which re-runs it) ended with a
raw `Command failed: …` dump and exit 1 for anyone already set up. That case is
now reported as `mcp: already configured`, exits 0, and prints the
`claude mcp remove <name>` command needed to re-register with a new token —
the one thing the existing entry will not pick up on its own.
