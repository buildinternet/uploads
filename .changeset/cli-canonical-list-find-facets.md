---
"@buildinternet/uploads": minor
---

List, find, and facets complete the CLI's move to the canonical `/v1/workspaces/:workspace/files` surface (#613) — no legacy `/v1/:workspace` paths remain in the client. The client's own return shapes are unchanged: `list` adapts the canonical `{files, prefixes, cursor}` envelope back to `{items, cursor}` (and still honors `metadata: true` opt-in), and `findFiles` now calls `files/search`, which is non-paginated (server cap 100, narrowable with `limit`), so its `cursor` is always `null`.
