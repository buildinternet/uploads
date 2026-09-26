# `@uploads/plugin`

Version token for the uploads.sh Claude / Codex / Agent Plugins manifests.
Not published to npm. Claude caches installs by this number.

Bump it with a changeset, not a hand edit:

```md
---
"@uploads/plugin": patch
---

Why existing installs must pick this up.
```

`changeset version` writes `CHANGELOG.md` here and copies the new version into
`plugin.json`, `plugins/claude/uploads/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
and `.codex-plugin/plugin.json`. See
[docs/releasing.md](../../docs/releasing.md#plugin-version-claude--codex).
