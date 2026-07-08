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
2. Point `bucket_name` in `apps/api/wrangler.jsonc` at your bucket (the
   default binding expects `uploads-default`), or create one with
   `wrangler r2 bucket create`. Same-account buckets get binding-mode I/O;
   workspaces can instead carry their own S3 credentials for HTTP mode.
3. Register the workspace: `pnpm workspace:add default` — with no flags it
   lands in the shared `uploads-default` bucket under a `default/` prefix,
   served at `https://storage.uploads.sh`. Pass `--bucket` (and optionally
   `--binding` / `--public-base-url`) for a dedicated bucket instead.
4. `pnpm run deploy` — ships both workers (`deploy:api` → `api.uploads.sh`,
   `deploy:web` → the `uploads.sh` apex).

Use `pnpm run deploy`, not `pnpm deploy` — the bare form is pnpm's own
command. In CI, Workers Builds deploys each app from its own directory on
push to main.

## After wrangler.jsonc changes

Run `wrangler types` (or `pnpm --filter @uploads/api types`) so `Env` is
regenerated into `worker-configuration.d.ts`. Never hand-write that file.