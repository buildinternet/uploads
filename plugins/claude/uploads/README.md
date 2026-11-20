# uploads.sh plugin

Get screenshots, GIFs, screen recordings, and other files into GitHub pull
requests and issues from inside your coding agent. The plugin hosts each file
on [uploads.sh](https://uploads.sh) and gives your agent a stable public URL
to embed, so a PR can show a before/after or a recording of the bug instead of
describing it in prose.

The plugin is one folder (`plugins/claude/uploads`) in the common agent-plugin
layout. `.claude-plugin/plugin.json` is the manifest, `.mcp.json` declares the
hosted MCP server, and `skills/` holds the three skills. The same folder
serves every listing below. The plugin runs no hooks or local code.

## What it bundles

| Component                   | Invocation                      | Purpose                                                                 |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| github-screenshots skill    | `/uploads:github-screenshots`   | Capture, host, and embed a visual in a PR or issue                      |
| annotate-screenshots skill  | `/uploads:annotate-screenshots` | Add boxes, arrows, labels, and redactions to a capture                  |
| uploads-cli skill           | `/uploads:uploads-cli`          | Full reference for the optional `uploads` CLI                           |
| uploads MCP server          | (tools)                         | Hosted server at `https://agents.uploads.sh/mcp`                        |

The slash names in the table are how Claude Code invokes the skills. Other
agents discover the same `skills/` directory by layout.

In Claude Code you can also add the optional
[uploads-mod](https://github.com/buildinternet/uploads/tree/main/plugins/claude/uploads-mod) plugin from the same marketplace. It
shows staged screenshots above the prompt, attaches them when `gh pr create`
opens a PR, and reminds you to stage screenshots before a UI PR.

## Install

Pick your agent. The same folder serves both listings.

### Claude Code

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads@uploads
/plugin install uploads-mod@uploads   # optional, see above
```

uploads is also listed in the
[Claude directory](https://claude.ai/directory/uploads), where you can add it
on claude.ai and in Cowork.

### Grok Build

This plugin is submitted to the
[xAI plugin marketplace](https://github.com/xai-org/plugin-marketplace) as
`uploads`. Once listed, run `/plugin` in Grok Build, search for **uploads.sh**,
and install it. The marketplace pins a commit of this repo, so updates arrive
when the catalog entry is bumped.

## Sign in

On first use, the MCP server opens the uploads.sh sign-in and consent screen
in your browser. The token it issues can read and write files in the workspace
you pick. See <https://uploads.sh/auth.md>.

## License

Apache-2.0, the same license as this repository (`license` in
`.claude-plugin/plugin.json`).

## Data and network access

The plugin reaches these uploads.sh services:

- **`agents.uploads.sh`**: the hosted MCP server behind the upload, list,
  metadata, and comment tools. It receives the files you ask your agent to
  upload, their file names, and metadata such as the repository, branch, and
  PR number. Uploaded files are served from a public URL on uploads.sh, so
  anyone with the link can view them.
- **`api.uploads.sh`**: the REST API used by the optional `uploads` CLI. The
  skills only send requests here if you install the CLI and your agent runs
  it.
- **GitHub**: when you attach files to a PR or issue, one comment that embeds
  them is posted or updated. The uploads.sh GitHub App posts it in
  repositories where you install the app; otherwise the CLI posts it through
  your local `gh` login.

See the [privacy policy](https://uploads.sh/privacy) and
[terms](https://uploads.sh/terms).

## Updating

Third-party marketplaces don't update automatically by default. To pick up a
new version in Claude Code:

```
/plugin marketplace update uploads
/plugin update uploads@uploads
```

Grok Build updates when the xAI catalog entry's pinned commit is bumped.
