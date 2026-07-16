# Workspaces

Every request is scoped to a **workspace** — a tenant with its own credentials
and bearer token. Workspace records live in the `REGISTRY` KV namespace
(`ws:<name>`). Each record carries the storage provider, bucket, optional R2
binding name, optional public base URL, S3-style credentials if needed, and the
SHA-256 hashes and metadata for the workspace's tokens (raw tokens are never stored).

Nothing in the code treats any workspace as special.

## Usage accounting and budgets

D1 table `workspace_usage` tracks net `bytes` / `objects` and monthly
`uploads_in_period` per workspace (not per token). Updated best-effort from
`files-core` put/delete; read via `GET /v1/:workspace/usage` (`files:read`).

Optional **budgets** live on the workspace registry record (KV), same as
`maxUploadBytes`:

| Field                 | Meaning                                          |
| --------------------- | ------------------------------------------------ |
| `maxStorageBytes`     | Cap on net stored bytes                          |
| `maxUploadsPerPeriod` | Cap on puts in the current UTC calendar month    |
| `maxUploadBytes`      | Cap on a single image (default 25 MiB)           |
| `maxVideoUploadBytes` | Cap on video/mp4\|webm (default: same as images) |
| `retentionDays`       | Age (days) for purge-expired + daily worker cron |
| `autoPrefixBareKeys`  | Default true: bare keys become `f/<id>/<name>`   |
| `allowedKeyPrefixes`  | Put/sign must start with one of these roots      |
| `maxKeyDepth`         | Max `/`-separated segments after governance      |

Omit a field for unlimited (or no retention / unrestricted keys). Puts that
would exceed storage return **507** with `code: "storage_quota_exceeded"`;
monthly upload budget returns **429** with `code: "upload_budget_exceeded"`.
Key policy denials return **400** with `code: "key_prefix_not_allowed"` or
`key_too_deep`. `GET …/usage` includes the caps and remaining when set.

### Key destinations

CLI/MCP typed destinations map to fixed roots: **`screenshots`**, **`gh`**,
**`f`** (bare-key auto-prefix). Operators can lock a workspace to those roots
with `--allowed-prefixes default` (plus optional `--max-key-depth 8`). Put and
presign enforce the allowlist; list/delete do not, so orphans can still be
cleaned up. Unset policy = any nested path (internal/BYO).

### Configure limits

**Create** applies the shared/agent template by default (25 GB / 10k / 25 MB /
8 MB video / `f`+`screenshots`+`gh` / depth 8 — no retention):

```bash
pnpm workspace:add my-ws
pnpm workspace:add my-ws --max-storage 50GB          # override one field
pnpm workspace:add my-ws --retention-days 90         # opt-in expiry
pnpm workspace:add my-ws --no-default-limits         # start unlimited
```

Change later without re-minting tokens:

```bash
pnpm workspace:limits my-ws                          # show current
pnpm workspace:limits my-ws --max-storage 50GB
pnpm workspace:limits my-ws --max-uploads-per-month 20000
pnpm workspace:limits my-ws --clear-max-storage      # back to unlimited
pnpm workspace:limits my-ws --retention-days 90
pnpm workspace:limits my-ws --clear-retention-days
pnpm workspace:limits my-ws --allowed-prefixes default --max-key-depth 8
pnpm workspace:limits my-ws --clear-allowed-prefixes --clear-max-key-depth
pnpm workspace:limits my-ws --local                  # local KV for wrangler dev
```

Sizes accept `25MB`, `1GiB`, or raw byte counts. KV is cached ~60s on the
Worker — new limits apply on the next request after that.

### Reconcile and retention

- `POST /v1/:ws/usage/reconcile` — re-scan storage, fix ledger drift (`files:write`).
- `POST /v1/:ws/usage/purge-expired` — delete objects older than `retentionDays`
  (`files:delete`), then reconcile. No-op skip if retention is unset.

The API worker also runs a **daily cron** (`0 6 * * *` UTC) that purges every
workspace with `retentionDays` set. Retention uses object last-modified from
the store (R2 upload time).

**files-sdk:** reconcile/purge walk with `listAll()` on the workspace-prefixed
`Files` instance (metadata only — no body reads). Purge uses bulk
`delete(keys[])` so R2 can multi-delete. We do **not** use the in-memory
`usage()` plugin (not durable across Workers), nor the `softDelete` plugin
(recycle bin, not TTL). Bucket lifecycle via `files.raw` is bucket-wide and
doesn’t express per-workspace `retentionDays` on a shared bucket.

New `uploads login`-issued tokens are stored in D1 and carry an expiry and explicit
scopes. Workspace configuration and legacy tokens remain in `REGISTRY` KV. The
routine-agent default is `files:read` plus `files:write`, which is sufficient for
upload, listing, metadata, and managed attachment comments. Deletion requires
`files:delete`. Existing tokens without scope or expiry metadata retain their legacy
full-access behavior so deployment does not invalidate installed clients.

## Default model

By default, a workspace is a `<name>/` prefix in the shared `uploads-default`
bucket (binding `UPLOADS_DEFAULT`, public at `https://storage.uploads.sh`).
The record carries `prefix: "<name>/"` and creating one is a pure KV write.
Public URLs are `https://storage.uploads.sh/<name>/<key>`.

The prefix is applied in exactly one place — `createStorage()` in
`packages/storage` — so route code and clients never see it.

| Workspace | Bucket            | Public base URL                                |
| --------- | ----------------- | ---------------------------------------------- |
| `default` | `uploads-default` | `https://storage.uploads.sh` — generic hosting |

## Self-serve workspaces

Signed-in users with a **GitHub-linked account** can create their own
workspace without an operator: `/account/workspaces/new` is the create form
(also linked from the account sidebar), and `POST /v1/workspaces`
(session-authed, no `ADMIN_TOKEN`) backs it. Each membership has a dedicated
page at `/account/workspaces/<name>`. `uploads login` offers the same create
flow when the signed-in account has zero workspaces yet — interactively it
prompts to create one; non-interactively it errors with guidance.

Creation provisions a Better Auth organization (the caller as owner) and a
`ws:<name>` KV record in the shared `uploads-default` bucket, same as the
default model above: `prefix: "<name>/"`, `publicBaseUrl:
https://storage.uploads.sh`. Files land at
`https://storage.uploads.sh/<name>/<key>` — **public at an unguessable URL**,
same as every other workspace on the shared bucket. There is no private tier
today; don't put anything there you wouldn't want reachable by anyone who
guesses or leaks the URL.

A magic-link-only account gets a `403 github_required` and is prompted to
connect GitHub first (the web UI redirects into the GitHub-connect flow from
account settings).

### Self-serve limits

Self-serve workspaces start on a tighter template than the operator default,
and only an admin can raise them (`pnpm workspace:limits`, see above):

| Field                 | Self-serve default       |
| --------------------- | ------------------------ |
| `maxStorageBytes`     | 1 GB                     |
| `maxUploadsPerPeriod` | 3000 / UTC month         |
| `maxUploadBytes`      | 25 MB                    |
| `maxVideoUploadBytes` | 8 MB                     |
| `allowedKeyPrefixes`  | `f`, `screenshots`, `gh` |
| `maxKeyDepth`         | 8                        |

### Name rules

Workspace names must match `WS_NAME_RE` (2–63 lowercase letters, digits, and
hyphens). A short list of reserved names (`default`, `admin`, `api`, `www`,
and similar route/subdomain collisions) is rejected with
`400 reserved_workspace_name`. Names are also checked against a vendored
offensive-terms blocklist; a blocklist hit is indistinguishable from any other
invalid name and returns the generic `400 invalid_workspace_name` (the
blocklist itself is not part of this doc).

### Cap and errors

Each user may own at most **3 self-serve workspaces** (owner-role,
`selfServe`-flagged records only — BYO-bucket or operator-created workspaces
you belong to don't count against the cap). Deleting a self-serve workspace,
like any workspace, remains admin-only.

`POST /v1/workspaces` error codes:

| Status | `code`                    | Meaning                                                                                                                                  |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_workspace_name`  | Fails the name pattern, or blocklisted                                                                                                   |
| 400    | `reserved_workspace_name` | Collides with a reserved name                                                                                                            |
| 403    | `github_required`         | Account has no linked GitHub identity                                                                                                    |
| 403    | `workspace_cap_reached`   | Caller already owns 3 self-serve workspaces                                                                                              |
| 409    | `workspace_name_taken`    | Name already registered                                                                                                                  |
| 429    | —                         | Rate-limited (dedicated creation limiter, 3 attempts per minute per user, checked before the GitHub gate — not the shared write limiter) |

## Bring-your-own-bucket

Register with `--bucket` and the record points at a dedicated bucket (own
binding or S3 credentials, own `publicBaseUrl`, no prefix). The `buildinternet`
workspace on `buildinternet-dev` is the reference example.

## R2 credential paths

R2 workspaces have two credential paths on the same bucket:

1. **Workers binding** — the record's `binding` names an `r2_buckets` entry in
   `wrangler.jsonc`. Reads/writes with no egress and no keys. Same-account
   buckets only.
2. **Bucket-scoped S3 credentials** — stored in the workspace record. Used for
   presigning, or full HTTP-mode I/O for buckets with no binding (other
   accounts).

Secrets never go in `wrangler.jsonc` or source. Workspace secrets live in KV
records; global secrets go through `wrangler secret put` (prod) or
`.dev.vars` (local, gitignored).

## Register a workspace

```bash
pnpm workspace:add my-workspace \
  [--bucket my-bucket] [--binding UPLOADS] \
  [--public-base-url https://media.example.com]   # add --local for dev
```

The script prints the bearer token once. For local dev, use `--local` to write
to the simulated KV namespace.
