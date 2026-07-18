---
"@buildinternet/uploads": patch
---

Widen the token-mint scope types to accept `"workspace:invite"` and `"workspace:manage"` alongside the existing file and operator scopes, so CLI/SDK callers can request org-admin-gated workspace-governance scopes minted via `POST /v1/tokens` (#262). No new commands or flags.
