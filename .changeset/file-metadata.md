---
"@buildinternet/uploads": minor
---

Add queryable custom metadata to the CLI: `put --meta k=v` (repeatable), `attach`
now writes `gh.repo`/`gh.kind`/`gh.number`/`gh.ref` automatically (plus its own
`--meta` extras), new `meta get`/`meta set` commands, `list --meta k=v` and the
`find k=v...` alias for filtering objects by metadata.
