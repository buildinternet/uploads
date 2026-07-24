---
"@buildinternet/uploads": minor
---

`uploads admin invite create` now requires `--workspace`. It previously defaulted
to the communal `default` workspace, so a forgotten flag issued an invite
granting `files:read`/`files:write` on the shared tenant — and because
enrollment redemption mints a token without creating an org membership, the
recipient would not have appeared in any member list while still reading and
writing that workspace's files. Pass the workspace explicitly; naming `default`
still works.
