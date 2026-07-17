---
"@buildinternet/uploads": minor
---

Publish the `uploads screenshot` command (added in #202 but never released). Captures a URL or local HTML file and hosts it in one call, with local Chrome and server-side `/v1/render` backends. Supports `--viewport WxH@Nx`, `--wait`, `--selector`, `--full-page`, `--dark`/`--light`, `--via local|remote`, and `--out <file>` (with `--no-upload` for file-only).

Adds agent-friendly capture controls: `--hide <css>` (repeatable) hides overlays before capture and localhost/private targets auto-hide known framework dev toolbars (opt out with `--no-hide-dev-tools`); `--reduced-motion` settles animations; and `--eval <js>` / `--init-script <file>` run setup JS before capture (local backend only).
