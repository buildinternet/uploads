---
"@buildinternet/uploads": minor
---

Add `uploads admin invite create` as the user-facing invitation command and return a separate, non-secret onboarding page URL alongside the one-time login code. Alternate deployments can derive the page origin from `--api-url` or set it explicitly with `--web-url`; the previous `admin enrollment create` spelling remains supported.
