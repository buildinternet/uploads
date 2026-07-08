# Workspaces

Every request is scoped to a **workspace** — a tenant with its own credentials
and bearer token. Workspace records live in the `REGISTRY` KV namespace
(`ws:<name>`). Each record carries the storage provider, bucket, optional R2
binding name, optional public base URL, S3-style credentials if needed, and the
SHA-256 hash of the workspace's token (the token itself is never stored).

Nothing in the code treats any workspace as special.

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