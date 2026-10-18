---
"@buildinternet/uploads": patch
---

`uploads approve <key> --dry-run` now reports a held file correctly when its bytes have moved out of public storage, instead of failing with "Not found".
