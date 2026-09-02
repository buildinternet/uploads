# Non-media file types (issue #925)

## Problem

The default allowlist in `apps/api/src/guards.ts` accepts PNG, JPEG, GIF, WebP, AVIF, MP4, and
WebM. A `.log`, `.pdf`, `.json`, or `.zip` 415s. With `gh --attach` (CLI 2.99) covering images
and video on GitHub itself, non-media artifacts (Lighthouse and Storybook output, test reports,
PDFs, JSON, logs, zips) are the lane nobody serves for agents. PR #924 corrected the copy to
match today's behavior and left a "More file types — Soon" card on the homepage.

## Decisions

### Accepted types

The default allowlist grows to:

| Type               | Extensions                               | Sniff                 | Size cap        |
| ------------------ | ---------------------------------------- | --------------------- | --------------- |
| `application/pdf`  | pdf                                      | `%PDF-`               | `maxBytes`      |
| `application/zip`  | zip                                      | `PK\x03\x04`          | `maxBytes`      |
| `application/gzip` | gz, tgz                                  | `\x1f\x8b`            | `maxBytes`      |
| `video/quicktime`  | mov                                      | `ftyp` brand `qt`     | `maxVideoBytes` |
| `text/plain`       | txt, log, text, jsonl, ndjson, yaml, yml | declared + text check | `maxBytes`      |
| `text/markdown`    | md, markdown                             | declared + text check | `maxBytes`      |
| `text/csv`         | csv                                      | declared + text check | `maxBytes`      |
| `application/json` | json                                     | declared + text check | `maxBytes`      |

Stays out: `text/html`, `image/svg+xml`, `application/xml`/`text/xml`, `application/javascript`,
`application/octet-stream`, and anything else. The reason is the same as the existing SVG
exclusion: `storage.uploads.sh` is a bare R2 custom domain, and no Worker sits in front of it, so
nothing in this repo sets headers on that path — headers there are zone-level Cloudflare Transform
Rules (ops config, the same mechanism the nosniff follow-up below proposes), not something this
code controls. The stored content type is the control this code does own. HTML and SVG execute
script in that origin. The types above do not: browsers render `text/*` and `application/json` as
inert text, PDF opens in a sandboxed viewer (PDFium / PDF.js resource origin / PDFKit) that never
runs in the page origin, and zip/gzip have no inline handler and always download. `files-sdk`'s
`upload()` has no `contentDisposition` option, so forcing downloads from application code is not
available without an upstream change; a `Content-Disposition: attachment` Transform Rule scoped to
`text/*` and `application/json` is an optional hardening on the ops side, not needed for this set.

Ops follow-up (not code): add `X-Content-Type-Options: nosniff` on the storage hosts via the same
Cloudflare Transform Rule mechanism that sets `Cache-Control`. Modern browsers already refuse to
sniff `text/plain` into HTML, so this is belt-and-braces.

### Text types are declared-only, with a plausibility check

Text has no magic bytes. `inspectUpload` gains a `declaredType` argument and this order:

1. `detectContentType(bytes)` as today. A magic hit wins and must be in the allowlist. The
   declared header is ignored for sniffable bytes, exactly as now (a zip renamed to `.png` is
   still stored as zip, and rejected if zip is not allowed).
2. If sniffing returns `null` and `declaredType` is one of the four text types, is in the
   allowlist, and `looksLikeText(bytes)` passes, accept with the declared type.
3. Otherwise 415, with `details.declared` added alongside `details.allowed` so the error explains
   itself (`text/html` declared → "unsupported media type", allowed list shows it is out).

`looksLikeText` samples the first 8 KiB: no NUL byte, and valid UTF-8 (`TextDecoder` with
`fatal: true`; the sample is trimmed back to a code-point boundary before decoding so a cut
multibyte sequence is not a false negative). Empty bodies are already rejected earlier. No
HTML-shaped heuristics: the served type is what matters, and `text/plain` is inert.

The declared type is resolved server-side as: the request `Content-Type` (normalized like presign
does, params stripped, lowercased) when it is specific, else the final key's extension via a new
`contentTypeFromKey(key)` in `guards.ts` (same table as the CLI map). `application/octet-stream`
counts as unspecified. `putObject` takes `opts.declaredContentType` and applies the key-extension
fallback itself, so the hosted MCP (which passes a filename and never a type) works with no MCP
change, and CLIs older than this release (which send `application/octet-stream` for `.log`) work
too.

Presign already validates the declared type against the allowlist and cannot sniff; text types
join that path unchanged. The presign integrity gap for binary types is issue #410 and is not
widened here (a declared `application/pdf` carrying HTML bytes is served as PDF, which does not
execute).

### Size caps: no new plan field

Non-media types use `maxUploadBytes` (25 MB free, 100 MB Pro). `video/quicktime` joins
`VIDEO_TYPES` and uses `maxVideoUploadBytes`. No new `LIMIT_FIELDS` entry, no billing, admin, or
backfill work. The limits table row is already labeled "Max file size". `UploadInspection.kind`
gains `"file"` so 413 payloads and analytics stay honest.

### Ingest stays media-only

`github-ingest.ts` currently gates on "sniffed type is in the workspace allowlist". After this
change that would start mirroring every PDF and zip pasted into a PR into the Screenshots view.
The gate becomes allowlist membership **and** `image/*` or `VIDEO_TYPES`. Text types are
unreachable there anyway (ingest only sniffs). The existing "derives from the shared allowlist"
test keeps its meaning; a new case asserts a PDF is a permanent `unsupported_media_type` skip.

### Client pipeline

- `packages/uploads/src/embed.ts` `inferContentType` gains the extension rows above plus the
  missing `webm`. The copy in `packages/comment-render/src/index.ts` and the generated
  `packages/uploads/src/comment-render.generated.ts` follow (regenerate, do not hand-edit the
  generated file; check how it is produced first).
- `optimizeImageForUpload` returns early for a known non-image extension before any sharp call, and the EXIF-facts probe is
  gated the same way, so a 20 MB zip never touches sharp. Keys keep their original extension on
  passthrough (verify, do not assume).
- The managed comment already renders anything that is not an image or a poster-backed video as
  a `- [name](link)` bullet. No renderer change beyond the MIME map. MOV with a poster renders
  like MP4.
- Hosted MCP: no code change. Its `put` description gains one clause listing the accepted
  families.

### Web

- `apps/web/src/lib/public-file.ts` `videoTypes` gains `video/quicktime`. The `file` branch of
  `MediaStage` ("Preview unavailable / Open <name>") already covers PDF, text, and zip. Inline
  text/JSON preview on `/f/` is a follow-up issue, not this change.
- `workspace-screenshots.ts` already has `mov` in `VIDEO_EXT` and an `other` tile.
- `/admin/metrics` already buckets `other`. No change.
- Poster generation: `POSTER_SOURCE_CONTENT_TYPES = VIDEO_TYPES` picks up MOV automatically.
  Whether Media Transformations decodes a given MOV is best-effort and already fail-soft; verify
  one MOV on prod after deploy and note the result in the PR.

### Copy

Shipped in a second PR after the API change is live, so the site never claims what prod rejects:

- The text families are the ones that carry secrets in practice (logs, CI JSON, env dumps): the
  limits page and `put` help must say uploads are public and to scrub before uploading.
- `apps/web/src/content/docs/limits.mdx` Formats bullet: list the families, keep the SVG sentence,
  add "HTML is not accepted for the same reason", drop "is coming".
- `apps/web/src/pages/index.astro` "More file types" card: remove the Soon pill and the "Today:"
  sentence.
- `skills/github-screenshots/SKILL.md` "When gh --attach is enough": the file-type bullet becomes
  "The file is an image or video under 10 MB" and a new "Use uploads.sh when" bullet covers
  non-media artifacts (`gh --attach` takes images and video only).
- `skills/uploads-cli/SKILL.md`, `docs/cli.md`, CLI `put` help text, `AGENTS.md` line ~209,
  docs hub capability list, `/docs/attach` page, `llms.txt`/`llms-full.txt`: grep for
  "PNG, JPEG", "images and video", "image or video", and "any file" and correct each.
- Changelog entry under `apps/web/src/content/changelog/` (platform + CLI).
- Changeset: `"@buildinternet/uploads": minor` for the MIME map and optimizer skip.

## Testing

- `apps/api/test/guards.test.ts`: `detectContentType` for PDF, zip, gzip, MOV (`ftyp` + `qt  `)
  and MP4 unchanged; `contentTypeFromKey`; `looksLikeText` (ASCII, UTF-8 with a cut multibyte tail
  at 8 KiB, NUL → false, Latin-1 bytes → false); `inspectUpload` matrix: declared `text/plain` +
  text → ok; declared `text/plain` + PNG bytes → stored as PNG; declared `text/html` → 415;
  declared `application/octet-stream` + text → 415; no declared + key `.log` → ok via fallback;
  declared `text/plain` + binary → 415; PDF over `maxBytes` → 413 with `kind: "file"`; MOV uses
  `maxVideoBytes`.
- `apps/api/test/routes-files.test.ts`: PUT `.log` with `Content-Type: text/plain` → 200 with
  `contentType: text/plain`; PUT `.html` → 415; PUT PDF bytes → 200; presign `text/plain` accepted,
  `text/html` still rejected.
- `apps/api/src/github-ingest.test.ts`: PDF asset → permanent skip even though the allowlist
  accepts it.
- `packages/uploads` tests: `inferContentType` new rows; optimizer skipped for `.pdf`.
- `packages/comment-render` test: a `.pdf` item renders as a link bullet.
- `apps/web` test for `fileKind("video/quicktime") === "video"`.
- Prod verification after merge: `uploads put` a `.log`, `.pdf`, `.json`, `.zip`, `.mov`, and a
  `.html` (expect 415); open each `/f/` page; confirm a PR comment renders the bullets; confirm
  `text/markdown` and `text/csv` are echoed verbatim by the storage hosts; confirm a `.tgz`
  round-trips byte-for-byte (no transparent decompression, no `Content-Encoding: gzip` added at the
  edge); confirm one MOV plays in Chrome on `/f/`.

## Out of scope

- Inline text/JSON viewer on `/f/` (follow-up issue).
- A separate non-media size cap or plan field.
- Presign byte verification (#410).
- `Content-Disposition: attachment` on the storage hosts. Reachable as a zone Transform Rule (ops
  config, not this repo); optional hardening, not required for the accepted set.
- Ingesting non-media attachments from GitHub.
