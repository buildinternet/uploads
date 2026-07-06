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

## Workspaces (multi-tenant model)

All API routes are workspace-scoped: `/v1/:workspace/files/...`. A workspace
is a tenant record in the `REGISTRY` KV namespace (`ws:<name>` →
`WorkspaceRecord`, see `apps/api/src/workspace.ts`) carrying its provider,
bucket, optional R2 binding name, optional `publicBaseUrl`, optional S3
credentials, and the SHA-256 hash of its bearer token. Register workspaces
with `apps/api/scripts/add-workspace.mjs` (`--local` for dev KV). Never treat
`buildinternet` as special in code — it's just the first registered tenant.

R2 workspaces have **two credential paths on the same bucket**:

1. **Workers binding** (record's `binding` names an `r2_buckets` entry in
   `wrangler.jsonc`) — reads/writes, no egress, no keys. Same-account buckets.
2. **Bucket-scoped S3 credentials** (in the workspace record) — presigning,
   or full HTTP-mode I/O for buckets with no binding (other accounts).

Secrets never go in `wrangler.jsonc` or source: workspace secrets live in KV
records; any future global secrets go through `wrangler secret put` (prod) or
`.dev.vars` (local, gitignored).

## Conventions

- TypeScript strict, ESM only, `lib: ["ES2022"]` (no DOM — the Workers types
  own globals like `crypto.subtle.timingSafeEqual`).
- Auth is per-workspace bearer tokens, hashed + timing-safe compare, with
  uniform 401s so workspace names can't be enumerated — see
  `apps/api/src/workspace.ts`.
- Object keys are validated (`badKey` in `routes/files.ts`); URL parsing
  normalizes dot segments before handlers run.
- Follow Cloudflare Workers best practices: no floating promises, no
  module-level request state, secrets never in config or source.

## Roadmap (see README for detail)

Presigned upload URLs (`POST /v1/sign`); web UI on files-sdk's
`createFilesRouter` + browser client rather than more hand-rolled REST; more
providers in `packages/storage`; point the `github-screenshots` skill at this
API.
