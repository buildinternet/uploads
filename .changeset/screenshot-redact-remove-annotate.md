---
"@buildinternet/uploads": minor
"@uploads/plugin": minor
---

`uploads screenshot` now runs only in your local Chrome/Chromium, and gains `--redact <css>` to black out secrets before upload.

- New `--redact <css>` (repeatable; MCP `redact`) paints matching elements as solid boxes before capture. A selector that matches nothing fails the capture instead of uploading the page unredacted.
- Removed: server-side rendering (`--via remote`, `UPLOADS_SCREENSHOT_VIA`). `--via auto` and `--via local` still work; `--via remote` fails with a pointer to install Chrome.
- Removed: `uploads annotate`, `screenshot --annotate`, and the annotate-screenshots skill. Use `--redact` for secrets and a caption to point at what changed.
- Captured `url` metadata no longer keeps query strings or fragments, which often carry one-time tokens.
