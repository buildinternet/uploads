# Codex plugin

Manifest: [`.codex-plugin/plugin.json`](../../.codex-plugin/plugin.json).
Listing mark: [`assets/logo.png`](../../assets/logo.png) (the same pixel chevron as the site favicon).

Ships the checked-in skills, the hosted MCP server at
`https://agents.uploads.sh/mcp`, and the shared pre-PR hook in
[`hooks/hooks.json`](../../hooks/hooks.json) (`uploads hook pre-pr-screenshot`).
The hook requires the `uploads` CLI on `PATH`. After enabling the plugin, open
`/hooks` once and trust the hook if Codex asks.

Disable the reminder with `UPLOADS_HOOK_DISABLE=1`.
