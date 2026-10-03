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
| Staged media mod            | `/uploads-staged`               | Shows staged attachments above the prompt; attaches them on PR open     |

The staged media mod needs Claude Code 2.1.287 or later. Older versions load
the rest of the plugin and skip the mod. It draws in the terminal and the
Desktop app's Code tab. Elsewhere, such as the VS Code extension's chat panel
or `claude -p`, it still attaches files and tells Claude, but shows nothing.

On the Desktop app, the band shows thumbnails of the staged attachments. **View**
or `/uploads-staged` opens a pane where you can see each one, copy its
markdown, remove it, or copy the PR's feed link; the footnote links to your workspace on uploads.sh. **Hide** hides the band until
the staged set changes.

## Install

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads@uploads
```

uploads is also listed in the
[Claude directory](https://claude.ai/directory/uploads), where you can add it
on claude.ai and in Cowork.

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

On the Desktop app, the pane also runs `uploads delete` when you remove an
attachment, `uploads feed create` when you copy the feed link, and `gh pr view`
to find the branch's open PR. Thumbnails are fetched with `curl` from
`storage.uploads.sh`, resized by Cloudflare's image transform, and kept in the mod's session state.

Every program the mod starts goes through one helper. The full list:

| Program                                                                 | When                                                  | What it sends, and where                                                     |
| :---------------------------------------------------------------------- | :---------------------------------------------------- | :--------------------------------------------------------------------------- |
| `uploads staged --format json`                                          | Session start, after matching shell commands, at idle | Branch and repo name to the uploads.sh API                                   |
| `uploads attach --promote --pr <n> --repo <r> --from-branch <b> --json` | After `gh pr create`, when the repo is not linked     | PR number, repo and branch to the uploads.sh API, which posts the PR comment |
| `uploads feed create --repo <r> --pr <n>`                               | You press **Copy link** in the pane                   | Repo and PR number to the uploads.sh API                                     |
| `uploads delete <key>`                                                  | You press **Remove** in the pane                      | The file's key to the uploads.sh API                                         |
| `gh pr view` (current branch, and `<n> --repo <r>` after a PR opens)    | With the staged read, and after `gh pr create`        | Branch or PR number to the GitHub API                                        |
| `sh -c 'curl -sfL --max-time 15 "$1" \| base64'`                        | Drawing thumbnails on the Desktop app                 | A request for a resized image to `storage.uploads.sh`; nothing else          |

What the mod reads from the conversation: the text of shell commands Claude
runs (to spot the ones above that change what is staged) and the output of
`gh pr create` (to find the new PR's URL). It sends none of that text
anywhere; only the values in the table leave the machine.

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
