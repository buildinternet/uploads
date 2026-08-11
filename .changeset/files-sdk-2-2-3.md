---
"@buildinternet/uploads": patch
"@uploads/ui": patch
---

Bump the files-sdk peer range to ^2.2.3 (>=2.2.3 for @uploads/ui). 2.2.3 fixes list() content types on the S3/HTTP paths upstream; the pinned patch is re-cut against 2.2.3 and still carries the r2 endpoint override and the binding-path list() metadata hunk.
