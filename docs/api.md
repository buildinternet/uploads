# API

All `/v1` routes require the workspace's `Authorization: Bearer <token>`.
Unknown workspaces and bad tokens are indistinguishable (both 401).

## Errors

Every non-2xx response uses one nested envelope (same shape as either/releases):

```json
{
  "error": {
    "code": "storage_quota_exceeded",
    "type": "insufficient_storage",
    "message": "storage quota exceeded (…)",
    "details": { "maxStorageBytes": 1000 }
  }
}
```

| Field     | Role                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| `type`    | Coarse category; pins HTTP status (`validation` → 400, `not_found` → 404, …) |
| `code`    | Stable machine string clients branch on                                      |
| `message` | Human-readable; may change; never parse this                                 |
| `details` | Optional structured context for select codes                                 |

Throw `AppError` subclasses from `@uploads/errors` in route code; the API's
`onError` serializes them. See `packages/errors`.

## Routes

| Route                                                                | Description                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                                        | Liveness (no auth)                                                                                                                                                                                                                                                                                                                            |
| `POST /v1/abuse`                                                     | Public content report (no auth): `pageUrl` + optional `reason`/`message`/`contact`/`workspace`/`key`. D1 row + email to `abuse@uploads.sh`. Rate-limited; `ABUSE_DISABLED` kill switch                                                                                                                                                        |
| `PUT /v1/:workspace/files/:key`                                      | Upload raw body (sniffed type). Bare keys → `f/<id>/<name>`. Response includes `replaced: true` when the key already existed (overwrite). `gh/`-prefixed keys always overwrite; every other key refuses (`409 key_exists`) unless `?replace=1` (or `X-Uploads-Replace: 1`) is sent. Optional provenance headers (below)                       |
| `POST /v1/:workspace/files/sign`                                     | Presigned upload (`signedUploadUrl`); needs HTTP S3 credentials on the workspace. Mirrors the strict-overwrite gate on `PUT` (checked at mint time — refuses an existing strict key unless `replace: true` or the key is a managed `gh/` path); best-effort only, since the actual write happens later, direct-to-bucket, outside this worker |
| `GET /v1/:workspace/files?prefix=&limit=&cursor=`                    | List objects                                                                                                                                                                                                                                                                                                                                  |
| `GET /v1/:workspace/files/:key`                                      | Object metadata (includes allowlisted `metadata` when set)                                                                                                                                                                                                                                                                                    |
| `DELETE /v1/:workspace/files/:key`                                   | Delete object                                                                                                                                                                                                                                                                                                                                 |
| `GET /v1/:workspace/usage`                                           | Workspace usage snapshot (`bytes`, `objects`, `uploadsInPeriod`, …); requires `files:read`                                                                                                                                                                                                                                                    |
| `POST /v1/:workspace/usage/reconcile`                                | Rebuild `bytes`/`objects` from storage; requires `files:write`                                                                                                                                                                                                                                                                                |
| `POST /v1/:workspace/usage/purge-expired`                            | Delete objects older than `retentionDays`, then reconcile; requires `files:delete`                                                                                                                                                                                                                                                            |
| `POST /v1/:workspace/galleries`                                      | Create an empty public gallery; requires `files:write`                                                                                                                                                                                                                                                                                        |
| `GET /v1/:workspace/galleries`                                       | List workspace galleries with opaque cursor pagination; requires `files:read`                                                                                                                                                                                                                                                                 |
| `GET /v1/:workspace/galleries/:id`                                   | Read one owned gallery; requires `files:read`                                                                                                                                                                                                                                                                                                 |
| `PATCH/DELETE /v1/:workspace/galleries/:id`                          | Update or soft-delete gallery metadata; requires `files:write`                                                                                                                                                                                                                                                                                |
| `POST /v1/:workspace/galleries/:id/items`                            | Add one existing, publicly served workspace object; requires `files:write`                                                                                                                                                                                                                                                                    |
| `PUT /v1/:workspace/galleries/:id/items/order`                       | Replace the complete item order; requires `files:write`                                                                                                                                                                                                                                                                                       |
| `DELETE /v1/:workspace/galleries/:id/items/:item`                    | Remove a gallery membership without deleting its object; requires `files:write`                                                                                                                                                                                                                                                               |
| `GET /public/galleries/:id`                                          | Exact-ID public gallery read; no workspace listing or authentication                                                                                                                                                                                                                                                                          |
| `GET /v1/:workspace/galleries/by-reference`                          | Find linked gallery summaries by provider coordinate; requires `files:read`                                                                                                                                                                                                                                                                   |
| `GET/POST /v1/:workspace/galleries/:id/external-references`          | List or link coordinates; writes require `files:write`                                                                                                                                                                                                                                                                                        |
| `DELETE /v1/:workspace/galleries/:id/external-references/:reference` | Unlink a coordinate; requires `files:write`                                                                                                                                                                                                                                                                                                   |

`url` in responses is the durable public CDN URL when the workspace has a
`publicBaseUrl`, otherwise `null`. File put/list/head, presign, and gallery
item payloads also include `embedUrl`: the same object on the embed host when
dual-host policy applies (default for `storage.uploads.sh` /
`store.uploads.sh`), else `null`. Prefer `embedUrl` in GitHub markdown so
in-place overwrites revalidate through Camo; keep `url` for durable links.
Successful `PUT …/files/:key` also returns `replaced` (`true` when an object
already lived at that key). `PUT …?dryRun=1` returns the same fields without
writing — `replaced: true` means a real put would overwrite, and
`wouldRefuse: true` means a real put would instead be refused (see below).

**Overwrite semantics (issue #174):** `gh/`-prefixed keys (the managed
`attach`/`--pr`/`--issue` layout) always overwrite in place with no
confirmation gate — that hot-swap is intentional so PR/issue embed URLs stay
stable. Every other key is strict: a `PUT` to an existing non-`gh/` key
throws `409 Conflict` with `code: "key_exists"` and `details: { key, url,
embedUrl }` naming the existing object, unless the caller opts in with
`?replace=1` (or the `X-Uploads-Replace: 1` header). This is enforced in
`putObject` (`apps/api/src/files-core.ts`) — the one code path shared by the
REST route and the MCP worker — so both surfaces get the same contract
without duplicating the check. There is no server-side global escape hatch;
`UPLOADS_OVERWRITE=1` is a CLI-side default (see [cli.md](./cli.md)) that
just sends `replace=1` on the caller's behalf.
Worker override: optional `EMBED_PUBLIC_BASE_URL` (empty disables; any URL is
a self-hosted embed base). See [ops.md](./ops.md#dual-public-hosts-stable-vs-embed--github-camo).

### Galleries

Gallery IDs are opaque `gal_…` identifiers and do not encode a workspace or
GitHub coordinate. Owner responses use camelCase and include the workspace;
the unauthenticated public response uses an explicit allowlist and never emits
workspace ownership or object keys. Public items contain only `id`, `filename`,
`position`, `caption`, `altText`, `status`, `url`, `embedUrl`, and `contentType`.
Missing stored objects remain ordered tombstones with `status: "missing"` and
`url: null` / `embedUrl: null`.

The owner collection route returns metadata summaries without `items`; it does
not probe object storage. Fetch an individual gallery to hydrate current item
status, content type, size, and computed public URL.

All gallery mutations after creation require a positive `expectedVersion` in
the JSON body. A stale version returns HTTP 409 with the current version in
`error.details`. Adding an already-present object is idempotent (HTTP 200); a
new membership returns HTTP 201. Adding checks the context-derived workspace's
storage and rejects missing objects or objects without a public URL.

This first API slice deliberately excludes item metadata PATCH, batch add, and
upload-and-add convenience endpoints.

External-reference inputs currently support only
`{ "provider": "github", "coordinate": "owner/repo#123" }`. The server
normalizes casing and derives the locator, normalized identity, and fixed
GitHub issues URL; clients cannot submit those derived fields. Reverse lookup
is authenticated, tenant-scoped, cursor-paginated, and returns gallery
summaries without probing storage. References are deliberately not included in
the public gallery response yet.

### Object provenance metadata

Optional operational labels stored as R2 **custom metadata** (not EXIF, not on
the public CDN response body). Clients may send:

```http
X-Uploads-Meta-client: uploads-cli
X-Uploads-Meta-client-version: 0.4.0
X-Uploads-Meta-source-name: shot.png
X-Uploads-Meta-optimized: 1
X-Uploads-Meta-frame: phone
X-Uploads-Meta-keep-exif: 1
```

**Client allowlist** (others dropped): `client`, `client-version`, `source-name`,
`optimized`, `frame`, `keep-exif`. Values are printable ASCII, max 128 chars.
Never send tokens, workspace secrets, or PII.

**Server-only:** every put also stores `content-sha256` (lowercase hex SHA-256 of
the **final stored body**). Client-supplied `content-sha256` headers are ignored.

Put and head responses always include `metadata` with at least `content-sha256`.
The CLI/`uploads mcp` set the client fields automatically from optimize/frame
options.

### Usage ledger and budgets

`GET /v1/:workspace/usage` returns durable workspace counters (`bytes`,
`objects`, `uploadsInPeriod` for the UTC calendar month), updated best-effort
after put/delete. Keyed by workspace, not token. Overwrites adjust `bytes` by
size delta; deletes free bytes/objects but not the monthly upload count.

When the workspace record sets budgets (`maxStorageBytes`,
`maxUploadsPerPeriod`), the response also includes those caps and remaining
headroom. Puts that would exceed them fail with (fields on `error`):

| HTTP | `type`                 | `code`                   | Meaning                                              |
| ---- | ---------------------- | ------------------------ | ---------------------------------------------------- |
| 507  | `insufficient_storage` | `storage_quota_exceeded` | Net stored bytes would exceed `maxStorageBytes`      |
| 429  | `rate_limited`         | `upload_budget_exceeded` | Monthly put count would exceed `maxUploadsPerPeriod` |
| 400  | `validation`           | `key_prefix_not_allowed` | Key not under `allowedKeyPrefixes` (put/sign)        |
| 400  | `validation`           | `key_too_deep`           | Key path segments exceed `maxKeyDepth`               |

Configure limits with `pnpm workspace:limits <name> …` (see
[workspaces](workspaces.md)). Bare keys are rewritten to `f/<id>/<name>` before
policy checks; presign uses the same finalization as put.

**Reconcile** scans every object under the workspace prefix and replaces ledger
`bytes`/`objects` (monthly upload count is preserved). Use after external
deletes or if counters look wrong:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://api.uploads.sh/v1/$WS/usage/reconcile
```

**Purge expired** deletes objects whose store last-modified is older than
`retentionDays` on the workspace record, then reconciles. Skips with
`{ "skipped": true }` when retention is unset.

## Example

```bash
curl -X PUT https://api.uploads.sh/v1/default/files/screenshots/myapp/42/shot.png \
  -H "Authorization: Bearer $UPLOADS_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @shot.png
```

## CLI

The `@buildinternet/uploads` package wraps the API for GitHub image embeds.
Examples assume the CLI is installed globally (`uploads`); use
`pnpm uploads …` only when developing inside this monorepo.

```bash
uploads put <file>
uploads put <file> --pr <num> --comment   # PR attachment + managed GitHub comment
uploads gallery create --title "Release screenshots"
uploads put <file> --gallery <gallery-id>
uploads usage
uploads reconcile
uploads purge-expired
```

See `skills/uploads-cli/SKILL.md` for agent-oriented usage.
