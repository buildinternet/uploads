---
"@buildinternet/uploads": patch
---

`uploads invite create` now says whether the invitation was emailed or whether the install has no email configured and the accept link must be shared by hand (`emailConfigured` also appears in `--json` output). Older auth workers that don't report the field keep the previous hedged copy.
