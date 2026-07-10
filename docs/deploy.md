# Deploy

Works against any Cloudflare account — this repo carries no account-specific
secrets. Auth either interactively (`wrangler login`) or headlessly by setting
`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` in the repo-root `.env`
(`pnpm deploy` loads it automatically; see `.env.example`).

Forks: point `routes[0].pattern` in `apps/api/wrangler.jsonc` at your own
domain, or delete the `routes` block to serve from your `workers.dev`
subdomain.

## Steps

1. Create the registry: `wrangler kv namespace create REGISTRY`, paste the id
   into `apps/api/wrangler.jsonc`.
2. Create the enrollment database and add the emitted binding to
   `apps/api/wrangler.jsonc` as `DB`:
   ```bash
   cd apps/api
   pnpm exec wrangler d1 create uploads-production
   ```
3. Apply enrollment migrations locally during development:
   ```bash
   pnpm exec wrangler d1 migrations apply uploads-production --local
   ```
4. Point `bucket_name` in `apps/api/wrangler.jsonc` at your bucket (the
   default binding expects `uploads-default`), or create one with
   `wrangler r2 bucket create`. Same-account buckets get binding-mode I/O;
   workspaces can instead carry their own S3 credentials for HTTP mode.
5. Register the workspace: `pnpm workspace:add default` — with no flags it
   lands in the shared `uploads-default` bucket under a `default/` prefix,
   served at `https://storage.uploads.sh`. Pass `--bucket` (and optionally
   `--binding` / `--public-base-url`) for a dedicated bucket instead.
6. Apply D1 migrations remotely **before** deploying API code that depends on
   them, then deploy:
   ```bash
   cd apps/api
   pnpm exec wrangler d1 migrations apply uploads-production --remote
   cd ../..
   pnpm run deploy
   ```
   This ships both workers (`deploy:api` → `api.uploads.sh`,
   `deploy:web` → the `uploads.sh` apex).

D1 owns short-lived enrollment state, redemption, and all new scoped/expiring tokens.
KV remains the source of truth for workspace storage configuration and legacy tokens.
Never deploy a Worker that reads a new D1 schema before the corresponding remote
migration succeeds. Check in every migration and test both `--local` and `--remote`
ordering in staging.

Use `pnpm run deploy`, not `pnpm deploy` — the bare form is pnpm's own
command. In CI, Workers Builds deploys each app from its own directory on
push to main.

## After wrangler.jsonc changes

Run `wrangler types` (or `pnpm --filter @uploads/api types`) so `Env` is
regenerated into `worker-configuration.d.ts`. Never hand-write that file.
