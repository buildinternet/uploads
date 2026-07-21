---
"@buildinternet/uploads": patch
---

Scope failures are now actionable: an `insufficient_scope` API error surfaces as "token lacks the files:delete scope" with a hint to re-run `uploads login` (or mint with `--scopes`), instead of a bare "forbidden".
