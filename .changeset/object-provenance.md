---
"@buildinternet/uploads": minor
---

Send allowlisted object provenance on put (`X-Uploads-Meta-*`: client, version, optimize/frame flags, source name). Put/head return `metadata`, including server-computed `content-sha256` of the stored body.
