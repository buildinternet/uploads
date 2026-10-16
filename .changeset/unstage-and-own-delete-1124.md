---
"@buildinternet/uploads": minor
"@uploads/plugin": patch
---

Add `uploads unstage` to clear a branch's staged files without deleting them. A write token can delete `gh/` objects it uploaded, and a missing-scope error names the scope and where to mint it.
