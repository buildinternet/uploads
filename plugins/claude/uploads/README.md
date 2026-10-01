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
| Staged media mod            | (automatic)                     | Shows staged screenshots above the prompt; attaches them on PR open     |

The staged media mod needs Claude Code 2.1.287 or later. Older versions load
the rest of the plugin and skip the mod. It draws in the terminal and the
Desktop app's Code tab. Elsewhere, such as the VS Code extension's chat panel
or `claude -p`, it still attaches files and tells Claude, but shows nothing.

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

The staged media mod also runs the local `uploads` CLI, plus `gh pr view`,
with their own sign-ins. It reads what is staged for the current branch (with
`uploads staged`) when a session starts and after shell commands that run
`uploads`, switch branches, or open a PR. After `gh pr create` opens a PR, it
looks up the PR's head branch:

- If the repository is linked to your workspace, the GitHub App attaches the
  staged files, and the mod only reports it.
- Otherwise, the mod runs `uploads attach --promote` for that PR. Turn off the
  **Attach staged files on gh pr create** option in `/plugin` to have it only
  report what is waiting.

If the CLI is not installed or not signed in, the mod does nothing.

See the [privacy policy](https://uploads.sh/privacy) and
[terms](https://uploads.sh/terms).

## Updating

Third-party marketplaces don't update automatically by default. To pick up a
new version:

```
/plugin marketplace update uploads
/plugin update uploads@uploads
```
