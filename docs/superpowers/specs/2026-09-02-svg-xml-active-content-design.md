# SVG and XML behind a verified sandboxing CSP (issue #929)

## Problem

#928 opened uploads to PDF, zip, gzip, MOV, and text but kept SVG and XML out. Served inline, either
can run script (`<script>`, `on*` handlers, `<foreignObject>`, XSLT). GitHub accepts SVG; agents
produce SVG diagrams and XML reports. The storage hosts are bare R2 custom domains with no Worker,
so this repo cannot set response headers there; zone Transform Rules can. A BYO bucket's public
host is the owner's, and only they can set headers on it.

## Decision: one mechanism, per lane

An "active content" type (`image/svg+xml`, `application/xml`, `text/xml`) is accepted on a
storage lane only while that lane's public host is **verified** to serve those types with a
sandboxing CSP and `nosniff`. Verification is a probe: write an inert SVG under
`_internal/uploads-csp-verify/<uuid>.svg`, fetch it through the lane's public base URL, check the
headers, delete the object. The same probe runs against hosted and BYO lanes; only who sets the
header differs.

- **Hosted lanes** (`storage.uploads.sh`, `store.uploads.sh`, plus the `embed.uploads.sh` twin):
  ops sets the header with a zone Transform Rule (documented in `docs/ops.md`). A daily cron
  probes each hosted host and writes the result to KV. Every workspace on that host inherits it.
- **BYO lanes:** the owner sets the header on their host however they like. The probe runs as
  part of the existing lane verify (configure and activate) as a new recommended check, and on
  demand from the settings page. The result is stamped on the lane. Nothing is enabled until the
  probe passes; a failing probe later turns it back off.
- **Kill switch:** a Flagship flag `active-content-uploads`, fail-closed like the poster flag.
- **Workspace opt-out:** `activeContentUploads: false` on the workspace record turns it off for
  that workspace regardless of lane state. Off by admin edit (same surface as `videoPosterEnabled`).

### What the probe accepts

`Content-Security-Policy` must contain a `sandbox` directive with neither `allow-scripts` nor
`allow-same-origin` tokens, and `X-Content-Type-Options: nosniff` must be present. Any other CSP
directives are the owner's business; a stricter or differently shaped policy still passes. The
response `Content-Type` must start with `image/svg+xml` (a host that rewrites the type fails).
The fetch uses `redirect: "manual"` with the existing 5 s timeout; a thrown fetch is
`inconclusive` (same semantics as the public-url check: unknown, not broken). Inconclusive never
enables.

Recommended header values for the docs and the ops rule:

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox
X-Content-Type-Options: nosniff
```

## Server

### Guards (`apps/api/src/guards.ts`)

Three new rows in `UPLOAD_TYPES`, all `kind: "file"` except SVG (`image`), `verify: "declared"`,
and a new `gate: "active-content"`:

| Type              | Extensions | Plausibility                                                                |
| ----------------- | ---------- | --------------------------------------------------------------------------- |
| `image/svg+xml`   | svg        | `looksLikeText` and `<svg` within the first 4 KiB after any prolog/comments |
| `application/xml` | xml        | `looksLikeText` and first non-whitespace char is `<`                        |
| `text/xml`        | (none)     | same as `application/xml`; accepted by declaration only                     |

Declared-only, not sniffed, on purpose: a `.log` that starts with `<?xml` keeps being
`text/plain`, and a `.png` carrying SVG bytes still 415s. The row's plausibility predicate replaces
the single `looksLikeText` call in `inspectUpload` (each declared row names its own check; the
text rows keep `looksLikeText`).

`resolveUploadPolicy(record, { activeContent: boolean })`: gated rows are removed from the
allowlist unless `activeContent` is true. This applies to a workspace's own `allowedContentTypes`
override too, so an override can no longer smuggle SVG onto an unverified lane. All callers
(`putObject`, presign, ingest, MCP ceiling) pass the gate result.

A reputation pre-filter `containsActiveMarkup(text)` rejects SVG/XML bodies containing
`<script`, `on[a-z]+\s*=`, `javascript:`, `<foreignObject`, or `<?xml-stylesheet`. It is documented
as reputation defense, not the control; the CSP is the control. It only ever runs on a body a
server handler actually buffers (PUT, MCP, server-side copies) — a presigned upload goes straight
to the bucket with no server inspection at all, which is exactly why the CSP, not this filter, is
the control.

### Gate (`apps/api/src/active-content.ts`, new)

```ts
export async function activeContentAllowed(env: Env, ws: WorkspaceRecord): Promise<boolean>;
```

Order, cheapest first: `ws.activeContentUploads === false` → false; `!env.FLAGS` → false; flag
false or thrown → false; then the lane check:

- shared lane (`isSharedLane(ws)`): read KV `REGISTRY` key `host-active-content:<host>` where host
  is the hostname of `ws.publicBaseUrl`; allowed when `ok` and `verifiedAt` within 48 h.
- BYO lane: `ws.storageActiveContentVerifiedAt` within 30 days and no `storageUnhealthyAt`.

Host records: `{ ok: boolean; verifiedAt: string; detail?: string }`.

### Probe (`apps/api/src/storage-verify.ts`)

`checkActiveContentHeaders(publicBaseUrl, probeKey, fetchImpl)` returns a `StorageVerifyCheck`
with id `active-content-headers`, `required: false`. `verifyStorageConfig` runs it after the
public-url check succeeds (it reuses the round-trip client to upload/delete the SVG probe). A
shared helper `parseSandboxCsp(header)` does the token check and is unit tested on its own.

### Lane state

- `StorageLane.activeContentVerifiedAt?: string` and top-level
  `WorkspaceRecord.storageActiveContentVerifiedAt?: string`; `promoteLane`/`demoteActiveLane` carry
  it like `verifiedAt`. `storagePutHandler` and `storageActivateHandler` set or clear it from the
  verify result. `StorageLaneStatus` and the active-lane status gain `activeContentVerifiedAt`.
- New route `POST /v1/workspaces/:name/storage/lanes/:laneId/verify-active-content` (session
  admin gate, write-limited): runs only the probe against that lane and updates the stamp.
- Hosted hosts: `runActiveContentHostSweep(env)` joins the daily cron; it probes each hosted host
  (the set from `packages/storage` `DEFAULT_EMBEDDABLE_HOSTS` plus the embed host) via a
  dedicated probe object in the default bucket and writes the KV host records. An admin route
  `POST /admin/active-content/probe` runs it on demand.

### Web

- `fileKind("image/svg+xml")` → `image`; the `unsupported` branch is retired. `/f/` renders SVG
  through `<img>` (never inline). `thumbUrl` keeps skipping `.svg`. XML is `file`.
- Settings → Storage: each lane card shows an "SVG and XML" row: "Verified <date>", or "Not
  verified" with the two header lines and a "Check now" button that calls the new route. The
  hosted lane shows the host record's state.
- Docs: `/docs/byo-bucket` gains a "Serving SVG and XML" section with the header values and the
  probe semantics; `/docs/limits` lists SVG/XML as "on verified lanes". `docs/ops.md` gets the
  Transform Rule expression and the cron/admin probe.

### CLI / renderer

`inferContentType` gains `xml` → `application/xml` (svg already present). The optimizer already
passes SVG through. The managed comment embeds SVG as `<img>` (GitHub's Camo serves it with its
own CSP); confirm on prod before the copy says so.

## Testing

- `parseSandboxCsp`: passes on the recommended value, on a policy with extra directives, on
  `sandbox` alone; fails on missing `sandbox`, `sandbox allow-scripts`, `sandbox allow-same-origin`.
- `checkActiveContentHeaders`: ok / wrong content type / missing nosniff / thrown fetch →
  inconclusive.
- `activeContentAllowed`: opt-out, missing flag, flag off, thrown flag, shared host fresh/stale/
  missing, BYO fresh/stale/unhealthy.
- Guards: gated rows absent by default and present only with `activeContent: true`; override
  containing svg still stripped without the gate; SVG plausibility (prolog + comment then `<svg`
  passes; `<html` fails); `containsActiveMarkup` matrix; `.log` starting with `<?xml` stays
  `text/plain`; `.png` named SVG bytes 415.
- Routes: PUT `.svg` 415 on an unverified workspace, 201 on a verified one (fake KV host record +
  flag on); presign same; the verify route updates the lane stamp; cron sweep writes host records.
- Web: `fileKind` cases; settings page renders the row.
- Prod: set the Transform Rule, run the admin probe, confirm the KV record, upload an SVG with a
  `<script>` (expect 415) and an inert one (expect 201), navigate to it in Chrome/Firefox/Safari
  and confirm no script runs and the document has an opaque origin (`window.origin === "null"`
  from devtools). Confirm Camo renders it in a PR comment.

## Out of scope

- Sanitizer-based acceptance.
- HTML.
- Automatic header setup on BYO hosts.
- Per-workspace custom CSP values (the probe accepts any sandboxing policy).

> **Record note (2026-09-02, post-review):** the shipped implementation probes an SVG and an XML object (both must pass), requires every hosted host to be verified for shared lanes, lets `serverCopy` bypass only freshness reasons, splits CSP directives on `;` only, adds a 60 s per-lane cooldown to the on-demand check, reaps orphaned probe objects daily, caps gated presigns at 900 s, and adds `nosniff` + `sandbox` to download responses. `docs/ops.md` and `/docs/byo-bucket` carry the live behavior.
