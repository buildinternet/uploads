# @uploads/plugin

## 0.4.6

### Patch Changes

- 901d994: The CLI warns once a day when your login token expires within 7 days, with the date and `uploads login --force` to renew it. JSON output (`--json`, `--format json`) and `--quiet` stay silent. The Claude Code mod opens its staged attachments pane on a file when uploads.sh newly holds it for review, so its Approve is one click away.

## 0.4.5

### Patch Changes

- 865ed9a: `uploads staged` marks files held for review (`held: true` in `--format json`, "held for review" in the human listing). The Claude Code mod draws a held file as a lock card instead of fetching its thumbnail, counts held files in the band, offers Approve in the pane's detail view, and says when files it attached on `gh pr create` are held.

## 0.4.4

### Patch Changes

- 532519e: The bundled github-screenshots skill now explains a held file in the managed comment and how to check and approve it.

## 0.4.3

### Patch Changes

- e921238: The bundled CLI skill now says a failed classifier call writes `ai.classifier=failed` and `ai.error` (`timeout`, `provider_error`, or `no_answer`).
- ecb281b: The bundled CLI skill now says the classifier skips a file when it cannot see an image. A skip is `small`, `unsupported`, `resize_failed`, or `resize_timeout`, and it does not write safety flags.
- 7c130b1: The bundled CLI skill now documents the internal classifier flags (`ai.rating`, `ai.content`, `ai.secret`, `ai.pii`). An installed agent can read and search them, and it should not treat them as public chips.
- 3c3758b: Add `uploads approve`. The classifier can now hold an upload it thinks shows a secret or sensitive personal data, and the managed PR comment shows a held count in its place. `uploads approve --pr <n>` lists held files, `--all` approves them, and `uploads approve <key>` approves one file. The local-gh comment path leaves held files out the same way the bot does. The bundled CLI skill documents the flow.
- 20f978b: The bundled CLI skill now says a flagged upload is held only when it came from CLI 0.59.0 or newer.

## 0.4.2

### Patch Changes

- 4879d8a: `uploads staged --branch` returns only that branch's still-staged files on private repos, and the Claude plugin no longer reports another branch's files as waiting.
- 5da7003: Add `uploads unstage` to clear a branch's staged files without deleting them. A write token can delete `gh/` objects the server stamped as that user's. Files uploaded before that stamp still need `files:delete`. A missing-scope error names the scope and where to mint it.

## 0.4.1

### Patch Changes

- e625574: The CLI skill documents the hosted MCP tools `list_activity` and `list_repo_files`, so existing plugin installs learn those reads.
- 95ef759: The pre-PR screenshot hook finds its script through `CLAUDE_PLUGIN_ROOT`, which Claude Code, Grok Build, and Codex all set.

## 0.4.0

### Minor Changes

- 69a235b: The staged media mod now has a desktop band and a pane. On the Desktop app's Code tab, the band shows the mark, a short headline, up to four thumbnails, a View button and a Hide button. View, or the new `/uploads-staged` command, opens a "Staged attachments" pane with a thumbnail grid, per-file detail, copy-markdown, remove, and a PR feed link. All surfaces now say "attachments" and leave the branch name out of the band.

### Patch Changes

- 87c470a: Rename a local `h` variable in the staged media mod so the Claude directory's policy check passes, and list every program the mod runs in the plugin README.

## 0.3.0

### Minor Changes

- 082469d: Add a Claude Code mod to the Claude plugin. It shows the screenshots staged for the current branch above the prompt. After `gh pr create` opens a PR, it attaches them with `uploads attach --promote`, or reports that the uploads.sh GitHub App will. It needs Claude Code 2.1.287 or later; older versions skip it. An **Attach staged files on gh pr create** option turns off the automatic attach.

## 0.2.3

### Patch Changes

- 79a2ca1: Move the Claude plugin into its own folder, `plugins/claude/uploads/`, so the Claude plugin directory validates only the plugin and not the whole repository. Adds a display name, an icon, and the privacy, terms, docs, and support links to the manifest, and a data and network access section to the plugin README.

## 0.2.2

### Patch Changes

- c997e2d: The plugin no longer bundles the maintainer-only `docs-page-style` skill; it moved to `.claude/skills/`.

## 0.2.1

### Patch Changes

- Bump the Claude/Codex plugin manifests so the hooks-load fix reaches existing installs.
