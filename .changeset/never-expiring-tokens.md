---
"@buildinternet/uploads": patch
---

`POST /v1/tokens` accepts `ttlSeconds: null` for a workspace token that does not expire. `/account/developers` offers that as **No expiry**. Revoke is the only off switch.
