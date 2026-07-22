---
"@buildinternet/uploads": minor
---

`attach --branch` now warns at stage time when the repo won't auto-attach staged files at PR open — either because it isn't linked to your workspace yet, or because it's linked to a different workspace. Advisory only: staging always succeeds regardless. Suppressed by `--quiet`, `UPLOADS_NO_NUDGE=1` (env or config), same as the bare-put nudge (#396).
