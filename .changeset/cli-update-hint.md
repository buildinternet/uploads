---
"@buildinternet/uploads": patch
---

Hint on stderr when a newer npm release of the CLI is available (cached daily; silence with `--quiet`, `UPLOADS_NO_UPDATE=1`, or `NO_UPDATE_NOTIFIER=1`). Add `--version`/`-V`, include the CLI version on `uploads doctor`, add Examples to login/admin help, and point usage errors at layered `uploads <cmd> --help` instead of dumping the full root manual.
