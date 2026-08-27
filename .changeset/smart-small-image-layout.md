---
"@buildinternet/uploads": minor
---

Managed comment sizes images by their real dimensions: uploads now record server-derived `image.width`/`image.height`, small assets render at natural size instead of being upscaled into blurry tiles, and consecutive captionless icons flow on one line instead of stacking one per row.
