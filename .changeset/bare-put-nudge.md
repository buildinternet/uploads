---
"@buildinternet/uploads": minor
---

`put` with no `--pr`/`--issue`/`--key` on a non-default git branch now prints a one-line nudge toward `--pr <num>` or `attach --branch`. Human mode writes it to stderr; `--format json` adds an additive `hint` field. Suppress with `--quiet`, `UPLOADS_NO_NUDGE=1`, or config `UPLOADS_NO_NUDGE=1`.
