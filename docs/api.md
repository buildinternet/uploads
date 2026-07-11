# API

All `/v1` routes require the workspace's `Authorization: Bearer <token>`.
Unknown workspaces and bad tokens are indistinguishable (both 401).

## Routes

| Route                                             | Description                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /health`                                     | Liveness (no auth)                                                                               |
| `PUT /v1/:workspace/files/:key`                   | Upload raw body (sniffed type). Bare keys → `f/<id>/<name>`. Optional provenance headers (below) |
| `POST /v1/:workspace/files/sign`                  | Presigned upload (`signedUploadUrl`); needs HTTP S3 credentials on the workspace                 |
| `GET /v1/:workspace/files?prefix=&limit=&cursor=` | List objects                                                                                     |
| `GET /v1/:workspace/files/:key`                   | Object metadata (includes allowlisted `metadata` when set)                                       |
| `DELETE /v1/:workspace/files/:key`                | Delete object                                                                                    |
| `GET /v1/:workspace/usage`                        | Workspace usage snapshot (`bytes`, `objects`, `uploadsInPeriod`, …); requires `files:read`       |
| `POST /v1/:workspace/usage/reconcile`             | Rebuild `bytes`/`objects` from storage; requires `files:write`                                   |
| `POST /v1/:workspace/usage/purge-expired`         | Delete objects older than `retentionDays`, then reconcile; requires `files:delete`               |

`url` in responses is the public URL when the workspace has a
`publicBaseUrl`, otherwise `null`.

### Object provenance metadata

Optional operational labels stored as R2 **custom metadata** (not EXIF, not on
the public CDN response body). Clients may send:

```http
X-Uploads-Meta-client: uploads-cli
X-Uploads-Meta-client-version: 0.3.0
X-Uploads-Meta-source-name: shot.png
X-Uploads-Meta-optimized: 1
X-Uploads-Meta-frame: phone
X-Uploads-Meta-keep-exif: 1
```

**Allowlist only** (others dropped): `client`, `client-version`, `source-name`,
`optimized`, `frame`, `keep-exif`. Values are printable ASCII, max 128 chars.
Never send tokens, workspace secrets, or PII.

Put and head responses include a `metadata` object when any allowlisted field
was stored. The CLI/`uploads mcp` set these automatically from optimize/frame
options.

### Usage ledger and budgets

`GET /v1/:workspace/usage` returns durable workspace counters (`bytes`,
`objects`, `uploadsInPeriod` for the UTC calendar month), updated best-effort
after put/delete. Keyed by workspace, not token. Overwrites adjust `bytes` by
size delta; deletes free bytes/objects but not the monthly upload count.

When the workspace record sets budgets (`maxStorageBytes`,
`maxUploadsPerPeriod`), the response also includes those caps and remaining
headroom. Puts that would exceed them fail with:

| HTTP | `code`                   | Meaning                                              |
| ---- | ------------------------ | ---------------------------------------------------- |
| 507  | `storage_quota_exceeded` | Net stored bytes would exceed `maxStorageBytes`      |
| 429  | `upload_budget_exceeded` | Monthly put count would exceed `maxUploadsPerPeriod` |
| 400  | `key_prefix_not_allowed` | Key not under `allowedKeyPrefixes` (put/sign)        |
| 400  | `key_too_deep`           | Key path segments exceed `maxKeyDepth`               |

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
uploads usage
uploads reconcile
uploads purge-expired
```

See `skills/uploads-cli/SKILL.md` for agent-oriented usage.
