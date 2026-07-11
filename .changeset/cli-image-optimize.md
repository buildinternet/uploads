---
"@buildinternet/uploads": minor
---

Optimize still images to WebP on `put`/`attach` (and MCP) by default for leaner GitHub embeds (EXIF stripped unless `--keep-exif`), with `--no-optimize` / `UPLOADS_NO_OPTIMIZE` escape hatch.
