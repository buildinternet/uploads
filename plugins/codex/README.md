# Codex plugin

Manifest: [`.codex-plugin/plugin.json`](../../.codex-plugin/plugin.json).
Listing mark: [`assets/logo.png`](../../assets/logo.png) (the same pixel chevron as the site favicon).

Ships the checked-in skills, the hosted MCP server in
[`.mcp.json`](../../.mcp.json) (`https://agents.uploads.sh/mcp`), and the shared
pre-PR hook in [`hooks/hooks.json`](../../hooks/hooks.json)
(`uploads hook pre-pr-screenshot`). Portal paste-ins (test cases, annotation
justifications) live in [submission.md](submission.md).
The hook requires the `uploads` CLI on `PATH`. After enabling the plugin, open
`/hooks` once and trust the hook if Codex asks.

Disable the reminder with `UPLOADS_HOOK_DISABLE=1`.
