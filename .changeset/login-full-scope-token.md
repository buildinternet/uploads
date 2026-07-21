---
"@buildinternet/uploads": minor
---

`uploads login` now mints a full-scope token by default (files:read, files:write, files:delete) so the CLI's own `delete` command works out of the box; pass `--scopes` to narrow it. `uploads doctor` now shows the token's scopes and hints when files:delete is missing.
