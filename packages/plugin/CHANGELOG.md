# @uploads/plugin

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
