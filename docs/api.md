# API

Public developer routes use `Authorization: Bearer <token>`. That is a
workspace token (`up_<workspace>_…`) from `uploads login` or
`/account/developers`. The workspace is always in the URL path. The CLI infers
it from the token. `POST /v1/tokens` defaults to 90 days; `ttlSeconds: null`
mints a token that does not expire.

The canonical resource hierarchy is `/v1/workspaces/:workspace/…`. These
routes also accept a signed-in uploads.sh session when the caller uses the web
application. API integrations should use a workspace token.

Unknown workspaces and bad tokens are indistinguishable (both 401).

## Idempotency

`POST /v1/workspaces/:workspace/galleries` accepts an optional
`Idempotency-Key` header. `POST /v1/:workspace/galleries` accepts the same
header and shares the same logical operation.

Use 1 to 255 visible ASCII characters. The API scopes the key to the workspace
and the current credential. It retains a successful response for 24 hours.
The same key and effective JSON body replay the original `201` response with
`Idempotency-Replayed: true`. The same key with a different effective body
returns `409 idempotency_key_reused`. A concurrent request can return
`409 idempotency_request_in_progress` with `Retry-After: 1`.

The JavaScript client generates a key for `createGallery`. Pass
`idempotencyKey` in the options when separate client calls must share a key.
After 24 hours, the same key starts a new operation.

`POST /v1/tokens` (workspace token minting) accepts the same header. A token is
shown only once, so a retried mint would otherwise either create a second token
or lose the only plaintext copy. With an `Idempotency-Key`, an identical retry
replays the original `201` — including the original one-time token — and mints
exactly one token; a changed request returns `409 idempotency_key_reused`. The
replay body is encrypted at rest, so minting requires the server's encryption
key to be configured and fails closed (`503`) otherwise. Authorization is
re-checked on every attempt: a caller who has lost workspace access cannot
recover a token by replaying a key. The client's `mintWorkspaceToken` accepts an
optional `idempotencyKey`.

`PUT /v1/workspaces/:workspace/files/:key` (object upload) accepts the same
header. The API scopes the key to the uploaded content and the rest of the
request. An identical retry replays the original `201`. That avoids both a
duplicate object and the `409 key_exists` a naive retry would hit on a strict
key. A retry with the same key but a different request returns
`409 idempotency_key_reused`. A concurrent request can return
`409 idempotency_request_in_progress` with `Retry-After: 1`. The client's `put`
accepts an optional `idempotencyKey`. Unlike `createGallery`, it is never
generated automatically — only supplied when the caller opts in.

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

## Canonical routes

| Route                                                                           | Description                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/abuse`                                                                | Public content report (no auth). D1 row + email to `abuse@uploads.sh`. Rate-limited; `ABUSE_DISABLED` kill switch                                                                                                               |
| `PUT /v1/workspaces/:workspace/files/:key`                                      | Upload a raw body. The API sniffs its type. A normal upload returns `201`; `?dryRun=1` returns `200` without writing. Bare keys become `f/<id>/<name>`. Strict keys require `?replace=1` or `X-Uploads-Replace: 1` to overwrite |
| `POST /v1/workspaces/:workspace/files/sign`                                     | Create a presigned upload. The workspace needs HTTP S3 credentials. The strict-overwrite check happens when the API creates the signed URL, so it is a best-effort guard rather than an atomic guarantee                        |
| `GET /v1/workspaces/:workspace/files?prefix=&delimiter=&limit=&cursor=`         | List objects with opaque cursor pagination. Response: `{ files, prefixes, cursor }`                                                                                                                                             |
| `GET /v1/workspaces/:workspace/files/search?meta.<key>=<value>&name=`           | Search by metadata equality and/or a filename substring. The response reports `truncated`; search does not yet return a continuation cursor                                                                                     |
| `GET /v1/workspaces/:workspace/files/facets?key=`                               | List queryable metadata keys or the values for one key                                                                                                                                                                          |
| `GET /v1/workspaces/:workspace/files/:key`                                      | Read object metadata. `?metadata=1` returns only the queryable metadata map                                                                                                                                                     |
| `PATCH /v1/workspaces/:workspace/files/:key`                                    | Merge queryable metadata with `{ set?, delete? }`                                                                                                                                                                               |
| `DELETE /v1/workspaces/:workspace/files/:key`                                   | Delete an object. Returns `200 { key, deleted: true }`                                                                                                                                                                          |
| `GET /v1/workspaces/:workspace/usage`                                           | Read workspace usage, limits, token scopes, and plan; requires `files:read`                                                                                                                                                     |
| `POST /v1/workspaces/:workspace/usage/reconcile`                                | Maintenance operation. Potentially expensive: scans storage and rebuilds `bytes` and `objects`; bearer token only; requires `files:write`                                                                                       |
| `POST /v1/workspaces/:workspace/usage/purge-expired`                            | Destructive maintenance operation. Permanently deletes objects older than `retentionDays`, then reconciles; bearer token only; requires `files:delete`                                                                          |
| `POST /v1/workspaces/:workspace/galleries`                                      | Create an empty public gallery; requires `files:write`; accepts `Idempotency-Key` for safe retries                                                                                                                              |
| `GET /v1/workspaces/:workspace/galleries?limit=&cursor=`                        | List enriched gallery summaries with opaque cursor pagination; requires `files:read`                                                                                                                                            |
| `GET /v1/workspaces/:workspace/galleries/:id`                                   | Read one owned gallery; requires `files:read`                                                                                                                                                                                   |
| `PATCH/DELETE /v1/workspaces/:workspace/galleries/:id`                          | Update or soft-delete gallery metadata; requires `files:write`                                                                                                                                                                  |
| `POST /v1/workspaces/:workspace/galleries/:id/items`                            | Add one existing, publicly served workspace object; requires `files:write`                                                                                                                                                      |
| `PUT /v1/workspaces/:workspace/galleries/:id/items/order`                       | Replace the complete item order; requires `files:write`                                                                                                                                                                         |
| `DELETE /v1/workspaces/:workspace/galleries/:id/items/:item`                    | Remove a gallery membership without deleting its object; requires `files:write`                                                                                                                                                 |
| `GET /v1/workspaces/:workspace/galleries/by-reference`                          | Find linked gallery summaries by provider and coordinate; requires `files:read`                                                                                                                                                 |
| `GET/POST /v1/workspaces/:workspace/galleries/:id/external-references`          | List or link external coordinates; writes require `files:write`                                                                                                                                                                 |
| `DELETE /v1/workspaces/:workspace/galleries/:id/external-references/:reference` | Unlink an external coordinate; requires `files:write`                                                                                                                                                                           |
| `GET /public/galleries/:id`                                                     | Read one public gallery by its opaque ID (no auth)                                                                                                                                                                              |

## Compatibility routes

The bearer-only `/v1/:workspace/files`, `/v1/:workspace/usage`, and
`/v1/:workspace/galleries` route families remain available. They preserve
existing response shapes for installed clients. New integrations should use
the canonical `/v1/workspaces/:workspace/…` hierarchy.

The canonical and compatibility routes share mutation handlers where their
contracts match. Some list envelopes intentionally differ. In particular, the
canonical file list returns `{ files, prefixes, cursor }`, while the
compatibility list returns `{ items, cursor }`. The canonical gallery list also
adds `itemCount`, `references`, and `previewUrl` to each summary.

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
`?replace=1` (or the `X-Uploads-Replace: 1` header). `putObject`
(`apps/api/src/files-core.ts`) enforces this — it is the one code path shared by
the REST route and the MCP worker, so both surfaces get the same contract
without a duplicated check. There is no server-side global escape hatch;
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

Put and head responses always include `provenance` with at least
`content-sha256`. The CLI/`uploads mcp` set the client fields automatically from
optimize/frame options.

**Two bags, two names.** `provenance` is this R2 bag. `metadata` always means
the queryable tier described below — on put, on `?metadata=1`, on `PATCH`, and
on a `?metadata=1` listing. Before this split, put and head called the
provenance bag `metadata`, which no client could tell apart from the queryable
tags. Read `provenance` for the upload's own labels and `metadata` for the tags
you set.

A put response reports `metadata` only when that put wrote tags: a put with no
`X-Uploads-Meta-*` header of its own leaves any existing tags untouched, so the
server omits the field rather than implying an empty set. The reported set
includes server-derived pairs the client never sent, such as `gh.uploader`. A
plain head returns no `metadata` at all — the queryable tier is a separate
store, so it takes a separate read (`?metadata=1`).

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

### Maintenance operations

**Reconcile (potentially expensive).** This operation scans every object under
the workspace prefix and replaces ledger
`bytes`/`objects` (monthly upload count is preserved). Use after external
deletes or if counters look wrong:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
  https://api.uploads.sh/v1/$WS/usage/reconcile
```

**Purge expired (destructive).** This operation permanently deletes objects
whose store last-modified is older than
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
uploads put <file> --pr <num>   # PR attachment + managed GitHub comment by default
uploads gallery create --title "Release screenshots"
uploads put <file> --gallery <gallery-id>
uploads usage
uploads reconcile
uploads purge-expired
```

See `skills/uploads-cli/SKILL.md` for agent-oriented usage.
