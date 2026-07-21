---
"@buildinternet/uploads": minor
---

Add a canonical metadata vocabulary for uploads. `screenshot` now derives
`url`, `path`, `env`, `theme` and `viewport` from the capture, and `put`
promotes an allowlist of image EXIF (`viewport`, `device`, `software`,
`captured`) into queryable metadata before stripping it from the bytes. New
`--state` and `--app` flags, and matching MCP params, cover what the CLI
cannot derive. `uploads find path=/settings state=after` is the payoff.

The MCP `metadata` description previously suggested `page` and `resolution`;
it now names the canonical keys and points at `path` as the one to search by.

Two behavior changes worth reading before upgrading:

- `device` and `software` come from EXIF that was previously discarded, and
  promoted metadata renders on the public file page. GPS coordinates, serial
  numbers and personal-name tags are never promoted.
- Metadata sent on a put fully replaces that key's stored set. Because derived
  keys count as metadata, a re-upload that derives anything now replaces the
  set where it previously left it untouched. Pass `--no-auto` when re-uploading
  a key whose metadata you curated with `uploads meta set`.

Opt out of the whole derived tier with `--no-auto` or `UPLOADS_NO_AUTO_META=1`.
