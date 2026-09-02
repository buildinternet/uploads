---
"@buildinternet/uploads": minor
---

`put` and `attach` accept SVG and XML (`image/svg+xml`, `application/xml`, `text/xml`) on a storage lane once its public host is verified to serve them behind a sandboxing Content-Security-Policy. An unverified lane keeps 415ing these types. The managed comment embeds SVG as `<img>`. Requires the matching platform release.
