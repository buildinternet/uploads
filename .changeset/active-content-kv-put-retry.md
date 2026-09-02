---
"@buildinternet/uploads": patch
---

The active-content host probe now retries a failed `REGISTRY` KV write once before giving up, so a stale prior-day `ok: true` record can't survive a one-off KV hiccup and keep the SVG/XML sandboxing gate open.
