# @uploads/plugin

## 0.2.3

### Patch Changes

- 79a2ca1: Move the Claude plugin into its own folder, `plugins/claude/uploads/`, so the Claude plugin directory validates only the plugin and not the whole repository. Adds a display name, an icon, and the privacy, terms, docs, and support links to the manifest, and a data and network access section to the plugin README.

## 0.2.2

### Patch Changes

- c997e2d: The plugin no longer bundles the maintainer-only `docs-page-style` skill; it moved to `.claude/skills/`.

## 0.2.1

### Patch Changes

- Bump the Claude/Codex plugin manifests so the hooks-load fix reaches existing installs.
