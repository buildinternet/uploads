---
"@buildinternet/uploads": minor
---

`uploads screenshot --out` now also writes a sidecar manifest (`<file>.uploads.json`) recording the capture's derived metadata (path/url/env/viewport, plus `--state` if given) with a content hash. A later `uploads put`/`attach` of that exact file automatically picks the metadata back up — explicit `--meta`/`--state` still win, and a regenerated or edited file silently loses its sidecar. Disable with `--no-sidecar`.
