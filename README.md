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

## API

All `/v1` routes require `Authorization: Bearer <AUTH_TOKEN>`.

| Route | Description |
|---|---|
| `GET /health` | Liveness (no auth) |
| `PUT /v1/files/:key` | Upload raw body; `Content-Type` header is stored. Returns `{ key, url, size }` |
| `GET /v1/files?prefix=&limit=&cursor=` | List objects |
| `GET /v1/files/:key` | Object metadata |
| `DELETE /v1/files/:key` | Delete object |

`url` in responses is the public URL when `PUBLIC_BASE_URL` is set (bucket
fronted by a custom domain), otherwise `null`.

```bash
curl -X PUT https://uploads.sh/v1/files/screenshots/myapp/42/shot.png \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: image/png" \
  --data-binary @shot.png
```

## Dev

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then edit
pnpm dev            # wrangler dev on :8787 (local R2 simulation)
pnpm typecheck
```

## Deploy

1. Create the bucket: `wrangler r2 bucket create uploads` (or point
   `bucket_name` in `apps/api/wrangler.jsonc` at an existing one).
2. Set config in `apps/api/wrangler.jsonc`: `STORAGE_BUCKET`,
   `PUBLIC_BASE_URL` (the bucket's custom domain, optional).
3. Secrets (from `apps/api`): `wrangler secret put AUTH_TOKEN`. Optionally
   `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`
   (bucket-scoped Object Read & Write token) — only needed for presigned URLs;
   reads/writes go through the R2 binding.
4. `pnpm deploy`

## Roadmap

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
