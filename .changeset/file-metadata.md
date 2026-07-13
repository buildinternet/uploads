---
"@buildinternet/uploads": minor
---

Add queryable custom metadata to the CLI: `put --meta k=v` (repeatable), `attach`
now writes `gh.repo`/`gh.kind`/`gh.number`/`gh.ref` automatically (plus its own
`--meta` extras), new `meta get`/`meta set` commands, `list --meta k=v` and the
`find k=v...` alias for filtering objects by metadata.

MCP parity: the local stdio MCP's `put`/`attach` tools gain a `metadata` param
(same gh.\* auto-injection as `attach`), and two new tools — `set_metadata`
(merge-set/delete) and `find_files` (metadata filter) — mirror the CLI's
`meta set`/`find`. The hosted MCP's `put` tool also gains a `metadata` param.
