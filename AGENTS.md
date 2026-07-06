# uploads

File-hosting backend for **uploads.sh**. Provider-agnostic storage via
[files-sdk](https://files-sdk.dev), deployed to Cloudflare Workers with
Wrangler. Internal tool, single user for now. Successor to the R2 upload
scripts in `buildinternet-skills/github-screenshots`.

## Layout

```
apps/api          Hono worker — REST API, deploys to uploads.sh
apps/web          Astro placeholder — future browse/manage UI (separate deploy)
packages/storage  @uploads/storage — files-sdk adapter factory
```

Keep API and web separate deployables. All storage access goes through
`createStorage()` in `packages/storage` — never import files-sdk adapters or
touch the R2 binding directly from route code. Adding a provider = a new case
in `createStorage` plus its files-sdk peer deps.

## Commands

```bash
pnpm install
pnpm dev                 # wrangler dev on :8787 (local R2 simulation)
pnpm typecheck           # wrangler types + tsc across workspaces
pnpm deploy              # wrangler deploy (apps/api)
pnpm --filter @uploads/web build
```

Run `wrangler types` (or `pnpm --filter @uploads/api types`) after any
`wrangler.jsonc` change — `Env` is generated into `worker-configuration.d.ts`,
never hand-written.

## Configuration

Non-secret config lives in `apps/api/wrangler.jsonc` `vars`; secrets go through
`wrangler secret put` (prod) or `apps/api/.dev.vars` (local, gitignored — copy
from `.dev.vars.example`). Never commit credentials.

R2 uses **two credential paths on the same bucket**, both supported and
deployer-configurable:

1. **Workers binding** (`UPLOADS`) — reads/writes, no egress, no keys needed.
2. **Bucket-scoped S3 credentials** (`R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
   `R2_SECRET_ACCESS_KEY`) — only for `url()` / `signedUploadUrl()` presigning
   (files-sdk hybrid mode). Optional until presigned uploads ship.

`PUBLIC_BASE_URL` is the bucket's public custom domain (differs from
uploads.sh); when set, responses include public object URLs.

## Conventions

- TypeScript strict, ESM only, `lib: ["ES2022"]` (no DOM — the Workers types
  own globals like `crypto.subtle.timingSafeEqual`).
- Auth is bearer-token (`AUTH_TOKEN` secret) with hashed timing-safe compare —
  see `apps/api/src/auth.ts`.
- Object keys are validated (`badKey` in `routes/files.ts`); URL parsing
  normalizes dot segments before handlers run.
- Follow Cloudflare Workers best practices: no floating promises, no
  module-level request state, secrets never in config or source.

## Roadmap (see README for detail)

Presigned upload URLs (`POST /v1/sign`); web UI on files-sdk's
`createFilesRouter` + browser client rather than more hand-rolled REST; more
providers in `packages/storage`; point the `github-screenshots` skill at this
API.
