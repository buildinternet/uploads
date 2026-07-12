---
"@buildinternet/uploads": minor
---

`uploads login` now signs you in through a browser by default: it opens a device-authorization page, you approve the request, and the CLI mints and saves a workspace token — no enrollment code to copy. When your account can access more than one workspace, pass `--workspace <name>`. The one-time enrollment-code path still works via `--code` / `--code-stdin`.
