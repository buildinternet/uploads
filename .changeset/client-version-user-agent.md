---
"@buildinternet/uploads": patch
---

API requests now send `User-Agent: @buildinternet/uploads/<version> (cli)`, or `(mcp)` from `uploads mcp`, so uploads.sh can tell which CLI version each token is using.
