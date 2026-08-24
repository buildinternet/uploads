---
"@buildinternet/uploads": patch
---

Upload files safely on retry: `put` now accepts an optional `idempotencyKey`
so a retried request replays the original response instead of writing a
duplicate object.
