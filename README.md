# uploads

Lightweight file-hosting backend on Cloudflare Workers, built on
[files-sdk](https://files-sdk.dev) so the storage layer is provider-agnostic
(R2 today; any files-sdk adapter later). Successor to the R2 upload scripts in
`buildinternet-skills/github-screenshots`.

> **Active development — not production-ready.** uploads.sh is being built in
> the open and its APIs (including auth) will change without notice. Don't rely
> on it for anything you can't afford to lose or re-key.

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

Every request is scoped to a **workspace** — a tenant with its own credentials
and bearer token. By default, a workspace is a `<name>/` prefix in the shared
`uploads-default` bucket (binding `UPLOADS_DEFAULT`, public at
`https://storage.uploads.sh`); the record carries `prefix: "<name>/"` and
creating one is a pure KV write. Bring-your-own-bucket is the advanced case:
register with `--bucket` and the record points at a dedicated bucket (own
binding or S3 credentials). Nothing in the code treats any workspace as special.
The default workspace ships ready to use:

| Workspace | Bucket | Public base URL |
|---|---|---|
| `default` | `uploads-default` | `https://storage.uploads.sh` — generic hosting |

Workspace records live in the `REGISTRY` KV namespace (`ws:<name>`). Each
record carries the storage provider, bucket, optional R2 binding name,
optional public base URL, S3-style credentials if needed, and the SHA-256
hash of the workspace's token (the token itself is never stored). Register
another with:

```bash
pnpm workspace:add my-workspace \
  [--bucket my-bucket] [--binding UPLOADS] \
  [--public-base-url https://media.example.com]   # add --local for dev
```

It prints the bearer token once.

### Minting upload tokens

Tokens are minted by an admin endpoint guarded by the `ADMIN_TOKEN` secret.
Set it once per environment:

```bash
# local: add ADMIN_TOKEN=... to apps/api/.dev.vars
# production:
cd apps/api && pnpm exec wrangler secret put ADMIN_TOKEN
```

Then mint a token (defaults to the `default` workspace):

```bash
curl -XPOST https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → { "workspace": "default", "token": "up_default_…", "label": null }

# a specific workspace, with an optional label:
curl -XPOST https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"acme","label":"ci"}'
```

The token is shown once. Minting appends — a workspace can hold several valid
tokens. The workspace must already exist (`pnpm workspace:add …`); this endpoint
issues tokens, it does not create workspaces.

List a workspace's tokens (the raw token and full hash are never returned — only
an 8-char `hashPrefix`, which is the handle for revoke):

```bash
curl https://api.uploads.sh/admin/tokens?workspace=default \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → { "workspace": "default", "tokens": [ { "label": "ci", "createdAt": "…", "hashPrefix": "a1b2c3d4" } ] }
```

Revoke a token by `hashPrefix` or `label`. A selector that matches no token is
`404`; one that matches more than one is `409` (pick a longer `hashPrefix`):

```bash
curl -XDELETE https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"default","hashPrefix":"a1b2c3d4"}'
# or: -d '{"workspace":"default","label":"ci"}'
```

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
curl -X PUT https://api.uploads.sh/v1/default/files/screenshots/myapp/42/shot.png \
  -H "Authorization: Bearer $UPLOADS_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @shot.png
```

## Dev

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm workspace:add default [--bucket uploads-default] [--binding UPLOADS_DEFAULT] --local
pnpm dev            # API on :8787 (local R2 + KV simulation); pnpm dev:web for the site
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
2. Point `bucket_name` in `apps/api/wrangler.jsonc` at your bucket (the
   default binding expects `uploads-default`), or create one with
   `wrangler r2 bucket create`. Same-account buckets get binding-mode I/O;
   workspaces can instead carry their own S3 credentials for HTTP mode.
3. Register the workspace: `pnpm workspace:add default` — with no flags it
   lands in the shared `uploads-default` bucket under a `default/` prefix,
   served at `https://storage.uploads.sh`. Pass `--bucket` (and optionally
   `--binding` / `--public-base-url`) for a dedicated bucket instead.
4. `pnpm run deploy` — ships both workers (`deploy:api` → `api.uploads.sh`,
   `deploy:web` → the `uploads.sh` apex). Note `pnpm run deploy`, not
   `pnpm deploy` — the bare form is pnpm's own command. In CI, Workers Builds
   deploys each app from its own directory instead.

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
- **Key/path governance** — today any authenticated client can write to any
  key in its workspace's bucket, which is fine for an internal audience but
  not long-term (especially in `uploads-default`). Future passes:
  - Bare filenames (no `/`) get an auto-generated unique prefix (e.g.
    `f/<shortid>/shot.png`) instead of landing in the bucket root — the root
    should never accumulate a million loose objects.
  - Typed destinations: a category like `screenshots` routes to its own
    prefix convention automatically (what the github-screenshots skill does
    by hand today with `screenshots/<repo>/<ref>/…`).
  - Per-workspace key policy in the registry record (allowed prefixes,
    max depth, reserved roots) enforced at upload time.
- **Encrypt BYO-bucket credentials at rest** — workspace records for external
  buckets carry S3 keys in KV; before opening to outside tenants, wrap those
  fields with an encryption key held as a Worker secret so KV read access
  alone doesn't yield credentials.
- **More providers**: add cases to `packages/storage` (`s3`, `gcs`, …).
- **Point `github-screenshots` at this API** — replaces its bundled SigV4
  script with one authenticated PUT.
