---
"@buildinternet/uploads": patch
---

Short `uploads --help` now lists every command the catalog marks essential.
Membership had two sources of truth — the `essential` flag in the command
catalog and a separate hardcoded array in the help renderer — and they had
drifted, so `screenshot` was flagged essential but never appeared. The catalog
is now the only source of truth; the array orders the list and nothing more,
and a mismatch in either direction fails loudly instead of silently hiding a
command.
