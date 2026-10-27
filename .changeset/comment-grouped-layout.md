---
"@buildinternet/uploads": patch
---

The managed PR comment the CLI posts through `gh` now matches the new bot layout. Phone screenshots share rows, up to three across. When most shots have a screen or path, they are grouped under a heading per screen, with that screen's before and after first. Once a comment has a before/after pair, a lone before or after gets a row with a "No before shot" or "No after shot" cell. The footer drops the file count and the "add media:" prefix.
