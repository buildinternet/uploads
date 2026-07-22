# uploads plugin

Get screenshots, GIFs, recordings, and files into GitHub PRs and issues via
[uploads.sh](https://uploads.sh) — workspace-scoped hosting built for showing
your work.

This directory holds the Claude Code plugin's tool-specific config. The plugin
itself is declared inline in [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json)
with `source: "./"`, so the whole repo is a one-plugin marketplace.

## What it bundles

| Component                   | Invocation                    | Purpose                                                                           |
| --------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| github-screenshots skill    | `/uploads:github-screenshots` | Capture + host + embed a visual in a PR/issue with a stable per-target key        |
| uploads-cli skill           | `/uploads:uploads-cli`        | Full `uploads` CLI reference — `put`, `attach`, `screenshot`, galleries, metadata |
| attach command              | `/uploads:attach`             | Explicit entry point for hosting a file or attaching to a PR/issue                |
| uploads MCP server          | (tools)                       | Hosted `https://agents.uploads.sh/mcp` — `put`, `list`, `attach`, galleries       |
| PR screenshot reminder hook | (automatic)                   | Advisory nudge to stage screenshots before `gh pr create` on a UI-touching branch |

Plugin skills and commands are namespaced by the plugin name (`uploads`), so
they appear as `/uploads:…`.

## PR screenshot reminder hook

A `PreToolUse` hook (matcher: `Bash`) watches for commands that run
`gh pr create`. When the current branch's diff against the repo's default
branch touches visually-observable files — `.astro`, `.tsx`, `.jsx`, `.vue`,
`.svelte`, `.html`, `.css`, `.scss`, `.less`, or anything under an `/email/`
path — and `uploads find gh.branch=<branch> --format json` comes back empty,
the agent gets a short advisory message suggesting
`uploads attach <shot.png> --branch --state after` before or after opening
the PR. It never blocks PR creation.

The hook fails open (silently does nothing) whenever it can't be sure:
non-matching commands, no git repo, no visual files in the diff, the
`uploads` CLI not installed/authenticated, or the `uploads find` call
erroring or exceeding its 5-second timeout. On a fork checkout it also tries
a best-effort `gh repo view --json isFork` check (3s timeout) and, if true,
appends a note that staged screenshots don't yet auto-promote into the PR
comment on fork branches ([issue #317](https://github.com/buildinternet/uploads/issues/317)).
That fork check is inherently best-effort — cross-checking the PR's actual
target repo, as opposed to just whether `origin` is a fork, isn't attempted.

**Disable it:** the hook honors `UPLOADS_HOOK_DISABLE=1`. Set it wherever
fits the scope you want — Claude Code's `env` settings block is the
established way to make that durable:

```jsonc
// ~/.claude/settings.json        → off everywhere, for you
// <repo>/.claude/settings.json   → off for everyone in one repo
// <repo>/.claude/settings.local.json → off for just your checkout
{
  "env": { "UPLOADS_HOOK_DISABLE": "1" },
}
```

Disabling the plugin itself also works but takes the skills and MCP server
with it. Claude Code has no per-hook toggle today, so the env var is the
supported per-hook switch.

## Install

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads@uploads
```

## MCP auth

The bundled MCP server points at the hosted endpoint,
`https://agents.uploads.sh/mcp`. On first use, Claude Code opens a browser to
the uploads.sh OAuth consent screen — sign in, approve access, and Claude Code
stores the resulting access token for you. No CLI install, no config file, no
environment variable to wire up.

Tokens carry `files:read` + `files:write` by default and are scoped to your
primary workspace (a fresh account with no workspace is prompted to create one
at <https://uploads.sh> before the tools will work). See
<https://uploads.sh/auth.md> for the full credential model.

If you'd rather use a long-lived per-workspace token instead of the OAuth
flow (e.g. for CI or a non-interactive agent), register the endpoint yourself
with the token baked in:

```
claude mcp add --transport http uploads https://agents.uploads.sh/mcp \
  --header "Authorization: Bearer up_<workspace>_…"
```
