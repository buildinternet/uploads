# @uploads/ui

## 0.1.2

### Patch Changes

- 17f4034: Bump the files-sdk range to ^2.2.4 (>=2.2.4 for @uploads/ui) and drop the pinned patch. 2.2.4 ships both hunks upstream: the r2 `endpoint` override (files-sdk#133) and binding-path list() metadata (files-sdk#134).

## 0.1.1

### Patch Changes

- e560cce: Bump the files-sdk peer range to ^2.2.3 (>=2.2.3 for @uploads/ui). 2.2.3 fixes list() content types on the S3/HTTP paths upstream; the pinned patch is re-cut against 2.2.3 and still carries the r2 endpoint override and the binding-path list() metadata hunk.
