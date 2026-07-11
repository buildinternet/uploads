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

| Field                 | Meaning                                       |
| --------------------- | --------------------------------------------- |
| `maxStorageBytes`     | Cap on net stored bytes                       |
| `maxUploadsPerPeriod` | Cap on puts in the current UTC calendar month |
| `maxUploadBytes`      | Cap on a single object (default 25 MiB)       |

Omit a field for unlimited. Puts that would exceed storage return **507** with
`code: "storage_quota_exceeded"`; monthly upload budget returns **429** with
`code: "upload_budget_exceeded"`. `GET …/usage` includes the caps and remaining
when set.

### Configure limits

Create with flags:

```bash
pnpm workspace:add my-ws --max-storage 25GB --max-uploads-per-month 10000 --max-upload-bytes 25MB
```

Change later without re-minting tokens:

```bash
pnpm workspace:limits my-ws                          # show current
pnpm workspace:limits my-ws --max-storage 50GB
pnpm workspace:limits my-ws --max-uploads-per-month 20000
pnpm workspace:limits my-ws --clear-max-storage      # back to unlimited
pnpm workspace:limits my-ws --local                  # local KV for wrangler dev
```

Sizes accept `25MB`, `1GiB`, or raw byte counts. KV is cached ~60s on the
Worker — new limits apply on the next request after that.

New enrollment-issued tokens are stored in D1 and carry an expiry and explicit scopes.
Workspace configuration and legacy tokens remain in `REGISTRY` KV. The routine-agent
default is `files:read` plus `files:write`, which is sufficient for upload, listing,
metadata, and managed attachment comments. Deletion requires `files:delete`. Existing
tokens without scope or expiry metadata retain their legacy full-access behavior so
deployment does not invalidate installed clients.

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
