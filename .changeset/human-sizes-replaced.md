---
"@buildinternet/uploads": patch
---

Print human-readable optimize sizes (e.g. `411.5 KB → 94.2 KB`) and note when a put overwrites an existing object (`replaced` on the API/JSON, `>> replaced existing object (same URL)` in human mode). `--dry-run` reports `would replace` / `"replaced": true` when the key already exists, without writing.
