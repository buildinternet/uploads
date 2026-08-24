---
"@buildinternet/uploads": patch
---

Mint workspace tokens safely on retry: `mintWorkspaceToken` now accepts an
optional `idempotencyKey` so a retried request replays the original one-time
token instead of minting a duplicate.
