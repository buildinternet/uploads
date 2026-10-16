---
"@buildinternet/uploads": minor
"@uploads/plugin": patch
---

Add `uploads unstage` to clear a branch's staged files without deleting them. A write token can delete `gh/` objects the server stamped as that user's. Files uploaded before that stamp still need `files:delete`. A missing-scope error names the scope and where to mint it.
