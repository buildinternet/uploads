---
"@buildinternet/uploads": patch
---

`uploads login --workspace <name> --create` provisions the workspace during login when the account doesn't have it yet, so scripted and agent logins can self-onboard without an interactive prompt (device approval in a browser is still required once). The zero-workspace non-interactive error now points at the flag.
