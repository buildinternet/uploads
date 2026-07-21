---
"@buildinternet/uploads": patch
---

Stop falling back to the local `gh` path when the server declines a comment post with `not_authorized` (cross-tenant repo binding) — surface the decline with a hint to `uploads github link --status` instead, since a silent gh fallback would just work around the server-side gate with the human's own credentials.
