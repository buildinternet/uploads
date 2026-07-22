---
"@buildinternet/uploads": minor
---

New `uploads staged [--branch <name>] [--repo <owner/name>] [--format json]`: a read-only view of what's staged for a branch (`attach --branch` / bare `put` on a non-default branch) and whether it will auto-attach once a PR opens. One `list` call against the branch staging prefix plus the repo-binding check (files:read only, no new server surface); `--format json` always prints a valid document, even with nothing staged. Also available as the `staged` tool on the local stdio MCP server.
