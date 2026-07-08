# uploads

File-hosting backend for **uploads.sh**. Provider-agnostic storage via
[files-sdk](https://files-sdk.dev), deployed to Cloudflare Workers with
Wrangler. Internal tool, single user for now. Successor to the R2 upload
scripts in `buildinternet-skills/github-screenshots`.

## Layout

```
apps/api            Hono worker — REST API, deploys to api.uploads.sh
apps/web            Astro placeholder — future browse/manage UI (separate deploy)
packages/storage    @uploads/storage — files-sdk adapter factory
packages/uploads    @buildinternet/uploads — CLI + client for GitHub image embeds
skills/uploads-cli  Agent skill for driving the CLI (host a file → embed in a PR/issue)
```

The `uploads-cli` skill in `skills/uploads-cli/SKILL.md` is checked in at the repo
root so it's installable via the `npx skills add` convention (`--skill uploads-cli`),
and is the API-backed successor to the `github-screenshots` skill's bundled R2
scripts. Keep it in sync when the CLI's commands or flags change.

Keep API and web separate deployables. All storage access goes through
`createStorage()` in `packages/storage` — never import files-sdk adapters or
touch the R2 binding directly from route code. Adding a provider = a new case
in `createStorage` plus its files-sdk peer deps.

## Commands

```bash
pnpm install
pnpm dev                 # API on :8787 (local R2 + KV simulation)
pnpm dev:web             # Astro site
pnpm typecheck           # wrangler types + tsc across workspaces
pnpm run deploy          # both workers; or deploy:api / deploy:web
pnpm workspace:add <name> [--bucket <bucket>] [--binding X] [--local]
pnpm uploads put <file> --env-file .env   # CLI (builds package first)
pnpm uploads put <file> --pr <num> --comment   # PR attachment + managed GitHub comment
```

Use `pnpm run deploy` (not bare `pnpm deploy` — that's pnpm's built-in).
Production deploys normally happen via Workers Builds on push to main.

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
any workspace as special in code — even `default` is just a registered tenant.

By default a workspace is a **`<name>/` prefix in the shared `uploads-default`
bucket** (binding `UPLOADS_DEFAULT`, public at `https://storage.uploads.sh`):
the record carries `prefix: "<name>/"` and creating one is a pure KV write.
The prefix is applied in exactly one place — `createStorage()` in
`packages/storage` (files-sdk instance prefix) — so route code and clients
never see it; public URLs are `https://storage.uploads.sh/<name>/<key>`.
Bring-your-own-bucket is the advanced case: register with `--bucket` and the
record points at a dedicated bucket (own binding or S3 credentials, own
`publicBaseUrl`, no prefix) — `buildinternet` on `buildinternet-dev` is the
reference example.

R2 workspaces have **two credential paths on the same bucket**:

1. **Workers binding** (record's `binding` names an `r2_buckets` entry in
   `wrangler.jsonc`) — reads/writes, no egress, no keys. Same-account buckets.
2. **Bucket-scoped S3 credentials** (in the workspace record) — presigning,
   or full HTTP-mode I/O for buckets with no binding (other accounts).

Secrets never go in `wrangler.jsonc` or source: workspace secrets live in KV
records; any future global secrets go through `wrangler secret put` (prod) or
`.dev.vars` (local, gitignored).

## Conventions

- `pnpm check` runs `oxlint` then `oxfmt --check`. Autofix with `pnpm lint:fix`
  / `pnpm format`. CI runs the same gate in the **Lint & Format** job
  (`.github/workflows/ci.yml`).
- A Husky pre-commit hook runs `lint-staged` (oxlint + oxfmt on staged files);
  it's installed via the `prepare` script on `pnpm install`.
- TypeScript strict, ESM only, `lib: ["ES2022"]` (no DOM — the Workers types
  own globals like `crypto.subtle.timingSafeEqual`).
- Auth is per-workspace bearer tokens, hashed + timing-safe compare, with
  uniform 401s so workspace names can't be enumerated — see
  `apps/api/src/workspace.ts`.
- Object keys are validated (`badKey` in `routes/files.ts`); URL parsing
  normalizes dot segments before handlers run.
- Follow Cloudflare Workers best practices: no floating promises, no
  module-level request state, secrets never in config or source.

## Environment files

- `.env.example` (repo root) — client vars (`UPLOADS_API_URL`,
  `UPLOADS_WORKSPACE`, `UPLOADS_TOKEN`), optional real R2 credentials for
  registering HTTP-mode dev workspaces, and `CLOUDFLARE_ACCOUNT_ID` /
  `CLOUDFLARE_API_TOKEN` for headless deploys to any account (`pnpm deploy`
  loads the file via `node --env-file-if-exists`). Copy to `.env`, gitignored.
- `apps/api/.dev.vars.example` — the worker's local config (Workers
  convention). Currently empty of secrets; workspace secrets live in KV.
- Never edit a user's `.env` / `.dev.vars` directly; template files only.

## Roadmap (see docs/roadmap.md for detail)

MCP server for agent access (primary users are agents); key/path governance
(auto-prefix bare filenames, typed destinations like `screenshots`,
per-workspace key policy — arbitrary paths are an internal-audience allowance,
not the end state); encrypt BYO-bucket S3 credentials in KV records before
external tenants; presigned upload URLs (`POST /v1/sign`); web UI on
files-sdk's `createFilesRouter` + browser client rather than more hand-rolled
REST; more providers in `packages/storage`; point the `github-screenshots`
skill at this API.
