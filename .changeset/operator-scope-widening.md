---
"@buildinternet/uploads": patch
---

Widen the token-mint scope types to accept `"operator:read"` and `"operator:write"` alongside the existing file scopes, so CLI/SDK callers can request operator scopes minted by an admin session (#257). No new commands or flags.
