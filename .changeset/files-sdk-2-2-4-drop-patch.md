---
"@buildinternet/uploads": patch
"@uploads/ui": patch
---

Bump the files-sdk range to ^2.2.4 (>=2.2.4 for @uploads/ui) and drop the pinned patch. 2.2.4 ships both hunks upstream: the r2 `endpoint` override (files-sdk#133) and binding-path list() metadata (files-sdk#134).
