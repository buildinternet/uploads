---
"@buildinternet/uploads": patch
---

Add request timeouts and bounded retry to the CLI's core API calls. JSON control calls now time out after ~15s and content uploads after ~60s instead of hanging for undici's ~5 minute default; a single retry follows network errors, 503, and 429 for idempotent GET/PUT calls, honoring the API's `X-Retry-After` header (capped at ~10s) when present.
