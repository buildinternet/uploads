---
"@buildinternet/uploads": patch
---

`uploads login` now replaces a saved token the server rejects (expired or revoked) without `--force`, and an expired token's error says when it expired.
