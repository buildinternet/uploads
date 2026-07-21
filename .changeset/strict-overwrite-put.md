---
"@buildinternet/uploads": minor
---

`put` (and the local/hosted MCP `put` tool) now refuse to overwrite an existing object on a "strict" key — an explicit `--key`, or the default put path with no `--pr`/`--issue` — instead of silently replacing it. `attach`, `put --pr`, and `put --issue` are unchanged: they always hot-swap in place so PR/issue embed URLs stay stable.

Pass `--replace` (MCP: `replace: true`) to opt in for one call, or set `UPLOADS_OVERWRITE=1` to restore the old always-overwrite behavior for strict-path puts. `--dry-run` now previews the refusal too (`>> would refuse: key already exists`).
