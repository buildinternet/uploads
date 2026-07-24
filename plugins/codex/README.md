# Codex plugin

Manifest: [`.codex-plugin/plugin.json`](../../.codex-plugin/plugin.json).

Ships the checked-in skills and the shared pre-PR hook in
[`hooks/hooks.json`](../../hooks/hooks.json) (`uploads hook pre-pr-screenshot`).
Requires the `uploads` CLI on `PATH`. After enabling the plugin, open `/hooks`
once and trust the hook if Codex asks.

Disable the reminder with `UPLOADS_HOOK_DISABLE=1`.
