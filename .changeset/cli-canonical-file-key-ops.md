---
"@buildinternet/uploads": minor
---

Per-key file operations — upload PUT, head/metadata GET, metadata PATCH, and DELETE — now use the canonical `/v1/workspaces/:workspace/files/<key>` paths (#613). The server has shared identical handlers across both surfaces since #636, so behavior is unchanged; the legacy paths keep working.

List, find, and facets stay on the legacy `/v1/:workspace/files` wildcard until the bearer list/search response shape is reconciled with the canonical one.
