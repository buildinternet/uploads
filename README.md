# uploads

Lightweight file-hosting backend on Cloudflare Workers, built on
[files-sdk](https://files-sdk.dev) so the storage layer is provider-agnostic
(R2 today; any files-sdk adapter later). Successor to the R2 upload scripts in
`buildinternet-skills/github-screenshots`.

## Layout

```
apps/api          Hono worker — REST API over storage (deploys via wrangler)
apps/web          Astro placeholder — future browse/manage UI
packages/storage  @uploads/storage — files-sdk adapter factory (provider registry)
```

The API and web app are separate deployables on purpose. `packages/storage` is
the seam for growth: `createStorage()` takes a `StorageConfig` whose `provider`
field selects the files-sdk adapter, so adding S3/GCS/etc. is one new case plus
peer deps — no API changes.

## Workspaces

Every request is scoped to a **workspace** — a tenant with its own bucket,
credentials, and bearer token. Nothing in the code treats any workspace as
special; landing in a particular bucket is always an intentional choice of
workspace. Registered in production today:

| Workspace | Bucket | Public base URL |
|---|---|---|
| `default` | `uploads-default` | `https://storage.uploads.sh` — generic hosting |
| `buildinternet` | `buildinternet-dev` | `https://media.buildinternet.dev` |

Workspace records live in the `REGISTRY` KV namespace (`ws:<name>`). Each
record carries the storage provider, bucket, optional R2 binding name,
optional public base URL, S3-style credentials if needed, and the SHA-256
hash of the workspace's token (the token itself is never stored). Register
one with:

```bash
cd apps/api
node scripts/add-workspace.mjs buildinternet \
  --bucket buildinternet-dev --binding UPLOADS \
  --public-base-url https://media.buildinternet.dev   # add --local for dev
```

It prints the bearer token once.

## API

All `/v1` routes require the workspace's `Authorization: Bearer <token>`.
Unknown workspaces and bad tokens are indistinguishable (both 401).

| Route | Description |
|---|---|
| `GET /health` | Liveness (no auth) |
| `PUT /v1/:workspace/files/:key` | Upload raw body; `Content-Type` header is stored. Returns `{ workspace, key, url, size }` |
| `GET /v1/:workspace/files?prefix=&limit=&cursor=` | List objects |
| `GET /v1/:workspace/files/:key` | Object metadata |
| `DELETE /v1/:workspace/files/:key` | Delete object |

`url` in responses is the public URL when the workspace has a
`publicBaseUrl`, otherwise `null`.

```bash
curl -X PUT https://api.uploads.sh/v1/buildinternet/files/screenshots/myapp/42/shot.png \
  -H "Authorization: Bearer $UPLOADS_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @shot.png
```

## Dev

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
cd apps/api && node scripts/add-workspace.mjs buildinternet --bucket buildinternet-dev --binding UPLOADS --local
pnpm dev            # wrangler dev on :8787 (local R2 + KV simulation)
pnpm typecheck
```

## Deploy

Works against any Cloudflare account — this repo carries no account-specific
secrets. Auth either interactively (`wrangler login`) or headlessly by setting
`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` in the repo-root `.env`
(`pnpm deploy` loads it automatically; see `.env.example`). Forks: point
`routes[0].pattern` in `apps/api/wrangler.jsonc` at your own domain, or delete
the `routes` block to serve from your `workers.dev` subdomain.

1. Create the registry: `wrangler kv namespace create REGISTRY`, paste the id
   into `apps/api/wrangler.jsonc`.
2. Point `bucket_name` in `apps/api/wrangler.jsonc` at your bucket (today:
   `buildinternet-dev`, public at `media.buildinternet.dev`), or create one
   with `wrangler r2 bucket create`. Same-account buckets get binding-mode
   I/O; workspaces can instead carry their own S3 credentials for HTTP mode.
3. Register the workspace: `node scripts/add-workspace.mjs buildinternet
   --bucket buildinternet-dev --binding UPLOADS --public-base-url
   https://media.buildinternet.dev`.
4. `pnpm deploy` — the worker attaches to `api.uploads.sh` (custom domain route); the apex stays free for the web app.

## Roadmap

- **MCP server** — the primary users are agents, so expose upload/list/delete
  as MCP tools (Cloudflare's `McpAgent` on the same worker, or a sibling
  worker on `mcp.uploads.sh`), authenticated per workspace like REST.
- **Presigned upload URLs** (`POST /v1/sign`) via files-sdk `signedUploadUrl()`
  — needs the hybrid-mode HTTP credentials above; lets clients PUT large files
  straight to the bucket.
- **Web UI**: files-sdk ships `createFilesRouter` + a browser client
  (`files-sdk/client`, `files-sdk/hono`) — mount it in the worker and the Astro
  app gets list/upload/download against the same bucket with per-operation
  authorization, without hand-rolling more REST.
- **More providers**: add cases to `packages/storage` (`s3`, `gcs`, …).
- **Point `github-screenshots` at this API** — replaces its bundled SigV4
  script with one authenticated PUT.
