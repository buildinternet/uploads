---
"@buildinternet/uploads": patch
---

Read width/height for SVG uploads from the root `<svg>` tag's `width`/`height` attributes (or `viewBox` as a fallback), so `image.width`/`image.height` server metadata — and the managed GitHub comment's sizing — now cover SVGs the same as other image types.
