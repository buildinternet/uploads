---
"@buildinternet/uploads": patch
---

Export the canonical metadata helpers (`stateProp`, `appProp`,
`canonicalMetaFromArgs`, `metadataArgWithCanonical`) from the `/mcp` entry
point so the hosted MCP server can reuse them instead of keeping its own copy
of the metadata tool description.
