---
"@buildinternet/uploads": minor
---

Publish the `uploads screenshot` command (added in #202 but never released). Captures a URL or local HTML file and hosts it in one call, with local Chrome and server-side `/v1/render` backends. Supports `--viewport WxH@Nx`, `--wait`, `--selector`, `--full-page`, `--dark`/`--light`, `--via local|remote`, and `--out <file>` (with `--no-upload` for file-only).
