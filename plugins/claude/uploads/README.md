# uploads plugin (Claude Code)

Claude Code plugin config for [uploads.sh](https://uploads.sh). The plugin is
declared in [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json)
with `source: "./"`, so the whole repo is a one-plugin marketplace.

## What it bundles

| Component                   | Invocation                    | Purpose                                                                     |
| --------------------------- | ----------------------------- | --------------------------------------------------------------------------- |
| github-screenshots skill    | `/uploads:github-screenshots` | Capture + host + embed a visual in a PR/issue                               |
| uploads-cli skill           | `/uploads:uploads-cli`        | Full `uploads` CLI reference                                                |
| attach command              | `/uploads:attach`             | Explicit host / attach entry point                                          |
| uploads MCP server          | (tools)                       | Hosted `https://agents.uploads.sh/mcp`                                      |
| PR screenshot reminder hook | (automatic)                   | Advisory nudge before `gh pr create` on a UI-touching branch with no stages |

Plugin skills and commands are namespaced (`/uploads:…`).

## Pre-PR screenshot reminder

Shared hook config: [`hooks/hooks.json`](../../../hooks/hooks.json). Runs
`uploads hook pre-pr-screenshot` on shell `PreToolUse`. Fail-open; disable with
`UPLOADS_HOOK_DISABLE=1`. Same file is used by the Codex plugin. Grok and Cursor
get the same command via `uploads install hooks`.

Requires the `uploads` CLI on `PATH`.

## Install

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads@uploads
```

## MCP auth

The bundled MCP server points at `https://agents.uploads.sh/mcp`. On first use,
Claude Code opens the uploads.sh OAuth consent screen. Tokens carry
`files:read` + `files:write` and are scoped to your primary workspace. See
<https://uploads.sh/auth.md>.

For a long-lived workspace token instead of OAuth:

```
claude mcp add --transport http uploads https://agents.uploads.sh/mcp \
  --header "Authorization: Bearer up_<workspace>_…"
```
