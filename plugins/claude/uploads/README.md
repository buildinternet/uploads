# uploads.sh plugin

Get screenshots, GIFs, screen recordings, and other files into GitHub pull
requests and issues from inside your coding agent. The plugin hosts each file
on [uploads.sh](https://uploads.sh) and gives your agent a stable public URL
to embed, so a PR can show a before/after or a recording of the bug instead of
describing it in prose.

The plugin is one folder (`plugins/claude/uploads`) in the common agent-plugin
layout. `.claude-plugin/plugin.json` is the manifest, `.mcp.json` declares the
hosted MCP server, `skills/` holds the three skills, and `hooks/` holds the
pre-PR reminder. The same folder serves every listing below.

## What it bundles

| Component                   | Invocation                      | Purpose                                                                 |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------- |
| github-screenshots skill    | `/uploads:github-screenshots`   | Capture, host, and embed a visual in a PR or issue                      |
| annotate-screenshots skill  | `/uploads:annotate-screenshots` | Add boxes, arrows, labels, and redactions to a capture                  |
| uploads-cli skill           | `/uploads:uploads-cli`          | Full reference for the optional `uploads` CLI                           |
| uploads MCP server          | (tools)                         | Hosted server at `https://agents.uploads.sh/mcp`                        |
| PR screenshot reminder hook | (automatic)                     | Advisory nudge before `gh pr create` on a UI branch with no screenshots |
| Staged media mod            | `/uploads-staged`               | Claude Code: staged attachments above the prompt, attached on PR open   |

The slash names in the table are how Claude Code invokes the skills. Other
agents discover the same `skills/` directory by layout.

The staged media mod (`hooks/register.tsx`) is Claude Code only. It needs
Claude Code 2.1.287 or later. Older versions load the rest of the plugin and
skip the mod. It draws in the terminal and the Desktop app's Code tab.
Elsewhere, such as the VS Code extension's chat panel or `claude -p`, it
still attaches files and tells Claude, but shows nothing.

On the Desktop app, the band shows thumbnails of the staged attachments.
**View** or `/uploads-staged` opens a pane where you can see each one, copy
its markdown, remove it, or copy the PR's feed link. The footnote links to
your workspace on uploads.sh. **Hide** hides the band until the staged set
changes.

## Install

Pick your agent. The same folder serves both listings.

### Claude Code

```
/plugin marketplace add buildinternet/uploads
/plugin install uploads@uploads
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

## Hooks

The pre-PR reminder is a `PreToolUse` hook with matcher `Bash`. A matcher can
only key the tool name, so the hook starts before Bash commands. The script
acts only on `gh pr create`. That filter lives in the uploads CLI, not in the
matcher.

The hook command names the script directly:

```text
"${CLAUDE_PLUGIN_ROOT}"/hooks/pre-pr-screenshot.sh
```

That path is the whole program. It uses `${CLAUDE_PLUGIN_ROOT}` and no other
variable. Claude Code sets `CLAUDE_PLUGIN_ROOT` to the installed plugin
directory. Grok Build sets `GROK_PLUGIN_ROOT` to that same directory and also
sets `CLAUDE_PLUGIN_ROOT`. Codex sets `PLUGIN_ROOT` and also sets
`CLAUDE_PLUGIN_ROOT`. Codex reads the `command` string and ignores an `args`
array, so the path stays in `command`.

The script runs the locally installed `uploads` CLI
(`uploads hook pre-pr-screenshot`). If the CLI is not installed or not signed
in, the hook does nothing. Set `UPLOADS_HOOK_DISABLE=1` to turn it off.

`hooks/register.tsx` is a separate Claude Code mod. It draws staged
attachments above the prompt. It is not part of the portable hooks contract.
It needs Claude Code 2.1.287 or later.

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

When the reminder hook runs (see [Hooks](#hooks)), it reads the branch name
and changed files from local git and asks the uploads.sh API whether any
files are staged for that branch. It uses the CLI's own sign-in. It prints a
reminder. It sends nothing if the CLI is missing or not signed in.

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
`storage.uploads.sh`, resized by Cloudflare's image transform, and kept in
the mod's session state.

Every program the mod starts goes through one helper, `run` in
`hooks/register.tsx`. That helper calls `$.process.run` with an argument
list, so a scan of that line cannot see the program. The helper runs only
the commands in this table, each written here as fixed text.

| Program                                                                               | Why it runs                                                                 | What it sends, and where                                                                                                                                             |
| :------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uploads staged --format json`                                                        | Session start, after a matching shell command, and when the session is idle | Branch and repository name to the uploads.sh API at `api.uploads.sh`, using the CLI's saved sign-in                                                                  |
| `uploads staged --format json --branch <branch> --repo <owner/repo>`                  | After `gh pr create`, to read files staged on the PR's head branch          | That branch and repository to the uploads.sh API                                                                                                                     |
| `uploads attach --promote --pr <n> --repo <owner/repo> --from-branch <branch> --json` | After `gh pr create`, when this workspace should attach the files           | PR number, repository, and branch to the uploads.sh API, which posts the PR comment                                                                                  |
| `uploads feed create --repo <owner/repo> --pr <n>`                                    | You press **Copy link** in the pane                                         | Repository and PR number to the uploads.sh API. The CLI prints the feed URL back to the mod                                                                          |
| `uploads delete <key>`                                                                | You press **Remove** in the pane                                            | The file's key to the uploads.sh API                                                                                                                                 |
| `gh pr view --json number,url,state`                                                  | With the staged read, to find the open PR for the current branch            | The current branch, through your local `gh` login, to the GitHub API                                                                                                 |
| `gh pr view <n> --repo <owner/repo> --json headRefName -q .headRefName`               | After `gh pr create`, to learn the PR's head branch                         | The PR number and repository to the GitHub API                                                                                                                       |
| `sh -c 'curl -sfL --max-time 15 "$1" \| base64' sh <url>`                             | Drawing a thumbnail or a large preview on the Desktop app                   | An HTTPS GET to `storage.uploads.sh`. For an image on that host, `<url>` is Cloudflare's image transform (`/cdn-cgi/image/...`). The JPEG stays in the mod's session |

`<branch>`, `<owner/repo>`, `<n>`, `<key>`, and `<url>` are the only parts
that change. The words of each command stay as written.

Local data the mod reads is the staged-file list from `uploads staged`, the
open PR from `gh pr view`, and those thumbnail bytes. It keeps them in the
mod's session state.

What the mod reads from the conversation: the text of shell commands Claude
runs, so it can spot `uploads`, a branch switch, or `gh pr create`, and the
output of `gh pr create`, so it can read the new PR's URL. That text stays
on the machine. The values that leave are the ones in the table, and each
one leaves through the program in its row.

If the CLI is not installed or not signed in, the mod does nothing.

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
