---
"@buildinternet/uploads": minor
---

Put and head responses now name the two metadata bags apart. `provenance`
carries the object's R2 upload labels (`client`, `source-name`,
`content-sha256`) — the content that used to sit under `metadata` on these two
endpoints only. `metadata` now means the queryable tags everywhere, matching
what it already meant on `getMetadata`, `patchMetadata`, and
`list({ metadata: true })`.

A put echoes the tags it stored, including server-derived pairs the client
never sent such as `gh.uploader`, so confirming what landed no longer takes a
second round trip. The field is absent when the put wrote no tags of its own,
since that case leaves any existing tags untouched. A plain head returns no
queryable metadata at all — that tier is a separate store and takes a separate
read, so call `getMetadata(key)`.

`PutResult.provenance` and `HeadResult.provenance` are new; `HeadResult.metadata`
is gone. Code reading `metadata` off a put or head for provenance must move to
`provenance`.
