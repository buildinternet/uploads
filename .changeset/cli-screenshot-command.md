---
"@buildinternet/uploads": minor
---

New `uploads screenshot <url|file.html>` command: capture a URL or a local
`.html` file and host it in one step, sharing the `put` upload pipeline
(`--frame`, optimize-by-default, `--pr`/`--issue` attachment + `--comment`).
Two capture backends selected by `--via auto|local|remote` (default `auto`,
or `UPLOADS_SCREENSHOT_VIA`): `local` drives an already-installed
Chrome/Chromium via `playwright-core` (an optional dependency — no browser
download), while `remote` renders server-side through a new uploads.sh
render endpoint. `auto` prefers local when a browser is found, else falls
back to remote; localhost/private-network targets and `.html` files stay
local-only. Also available as an MCP tool and reported in `uploads doctor`.
