---
"@buildinternet/uploads": patch
---

put/attach/screenshot no longer emit broken `![…](null)` markdown on workspaces without a public URL; the CLI now falls back to a plain-text note naming the uploaded key.
