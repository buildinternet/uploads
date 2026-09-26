# uploads.sh plugin

Get screenshots, GIFs, screen recordings, and other files into GitHub pull
requests and issues. The plugin hosts each file on
[uploads.sh](https://uploads.sh) and gives Claude a stable public URL to
embed, so a PR can show a before/after or a recording of the bug instead of
describing it in prose.

## What it bundles

| Component                   | Invocation                      | Purpose                                                                 |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| github-screenshots skill    | `/uploads:github-screenshots`   | Capture, host, and embed a visual in a PR or issue                      |
| annotate-screenshots skill  | `/uploads:annotate-screenshots` | Add boxes, arrows, labels, and redactions to a capture                  |
| uploads-cli skill           | `/uploads:uploads-cli`          | Full reference for the optional `uploads` CLI                           |
| uploads MCP server          | (tools)                         | Hosted server at `https://agents.uploads.sh/mcp`                        |
| PR screenshot reminder hook | (automatic)                     | Advisory nudge before `gh pr create` on a UI branch with no screenshots |

## Install

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads@uploads
```

## Sign in

On first use, the MCP server opens the uploads.sh sign-in and consent screen
in your browser. The token it issues can read and write files in the workspace
you pick. See <https://uploads.sh/auth.md>.

## Data and network access

The plugin reaches these uploads.sh services:

- **`agents.uploads.sh`**: the hosted MCP server behind the upload, list,
  metadata, and comment tools. It receives the files you ask Claude to upload,
  their file names, and metadata such as the repository, branch, and PR
  number. Uploaded files are served from a public URL on uploads.sh, so anyone
  with the link can view them.
- **`api.uploads.sh`**: the REST API used by the optional `uploads` CLI. The
  skills only send requests here if you install the CLI and Claude runs it.
- **GitHub**: when you attach files to a PR or issue, one comment that embeds
  them is posted or updated. The uploads.sh GitHub App posts it in
  repositories where you install the app; otherwise the CLI posts it through
  your local `gh` login.

The PR screenshot reminder hook runs the locally installed `uploads` CLI
before Claude runs a shell command. It acts only on `gh pr create`: it reads
the branch name and changed files from local git, asks the uploads.sh API
whether any files are staged for that branch (using the CLI's own sign-in),
and prints a reminder. If the CLI is not installed or not signed in, the hook
does nothing. Set `UPLOADS_HOOK_DISABLE=1` to turn it off.

See the [privacy policy](https://uploads.sh/privacy) and
[terms](https://uploads.sh/terms).

## Updating

Third-party marketplaces don't update automatically by default. To pick up a
new version:

```
/plugin marketplace update uploads
/plugin update uploads@uploads
```
