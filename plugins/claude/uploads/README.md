# uploads plugin

Get screenshots, GIFs, recordings, and files into GitHub PRs and issues via
[uploads.sh](https://uploads.sh) — workspace-scoped hosting built for showing
your work.

This directory holds the Claude Code plugin's tool-specific config. The plugin
itself is declared inline in [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json)
with `source: "./"`, so the whole repo is a one-plugin marketplace.

## What it bundles

| Component                | Invocation                    | Purpose                                                                           |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------- |
| github-screenshots skill | `/uploads:github-screenshots` | Capture + host + embed a visual in a PR/issue with a stable per-target key        |
| uploads-cli skill        | `/uploads:uploads-cli`        | Full `uploads` CLI reference — `put`, `attach`, `screenshot`, galleries, metadata |
| attach command           | `/uploads:attach`             | Explicit entry point for hosting a file or attaching to a PR/issue                |
| uploads MCP server       | (tools)                       | Local stdio `uploads mcp` — `put`, `list`, `attach`, galleries                    |

Plugin skills and commands are namespaced by the plugin name (`uploads`), so
they appear as `/uploads:…`.

## Install

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads@uploads
```

## MCP auth

The bundled MCP server runs the local CLI over stdio (`uploads mcp`). It reads
your workspace token from the config file `uploads login` writes
(`~/.config/buildinternet/config`), so once you've signed in there's nothing
else to set up:

```
npm install -g @buildinternet/uploads   # if the CLI isn't already installed
uploads login                            # device flow → stores the token
```

The CLI must be on your `PATH` for the bundled server to launch. Tokens carry
`files:read` + `files:write` by default and are scoped to a single workspace.
See <https://uploads.sh/auth.md> for the full credential model.

### Why not the hosted endpoint?

The hosted MCP at `https://agents.uploads.sh/mcp` authenticates with a bearer
token, but a static plugin manifest can't inject a per-user token. `uploads
login` stores the token in a config file, **not** an environment variable, so a
`${UPLOADS_TOKEN}` header would be empty for a normally signed-in user. Until
`agents.uploads.sh` exposes an OAuth authorization server that Claude Code can
complete interactively, the local stdio server is the one that works without
manual token wiring. To use the hosted endpoint anyway, register it yourself
with the token baked in (this is what `uploads install` does):

```
claude mcp add --transport http uploads https://agents.uploads.sh/mcp \
  --header "Authorization: Bearer up_<workspace>_…"
```
