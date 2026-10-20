---
"@buildinternet/uploads": patch
---

Once the server says a token expired, the CLI and the local MCP server stop sending it. Later calls fail right away with the same message until `uploads login` saves a new token, so background refreshes no longer hit the API with a dead token.
