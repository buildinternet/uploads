---
"@buildinternet/uploads": patch
---

Metadata discoverability polish: `uploads find` / `list --meta` now print each
match's matched metadata inline in human output (as `LIST_HELP` already
promised, previously only in `--json`); `uploads meta get` on an object with no
metadata prints a `(no metadata)` note to stderr instead of nothing; and
`uploads attach` prints a `find these later: uploads find gh.ref=…` hint so its
auto-written `gh.*` metadata is discoverable. README now lists the stdio MCP
`set_metadata`/`find_files` tools and the `put`/`attach` `metadata` param.
