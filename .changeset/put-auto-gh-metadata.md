---
"@buildinternet/uploads": minor
---

`uploads put` now stamps the four `gh.*` metadata pairs whenever it has a
GitHub target, so screenshots hosted on the default `screenshots/…` path get an
"Attached to" link on their `/f/` page. On by default: with `--pr`/`--issue`
the explicit target is used (previously the stable key was written without
metadata); otherwise `put` resolves the current branch's PR (or classifies a
numeric `--ref` as pull vs issue) via `gh`. Disable with `--no-auto`,
`--no-git`, or `UPLOADS_NO_AUTO_META=1`. Resolution is best-effort — a missing
`gh`, no PR, or an API error uploads normally without metadata.
