---
"@buildinternet/uploads": patch
---

The "add --meta path=/route" tip no longer fires when a `path` was in fact
supplied. `put --pr`/`put --issue` and `attach` decided whether to nudge by
reading the API's put response `metadata` field, which echoes the object's R2
provenance bag (`client`, `source-name`, `content-sha256`) and never the
queryable tags — so the tip printed on every image, including ones uploaded
with an explicit `--meta path=`, and the same text landed in the `hint` field
of `--format json`. The check now reads the metadata each upload actually sent
(`--meta` pairs, a `screenshot --out` sidecar manifest, and derived image
facts), resolved per file.
