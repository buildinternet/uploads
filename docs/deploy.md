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
2. Create the API's D1 database (tokens, usage ledger, legacy enrollment
   state) and add the emitted binding to `apps/api/wrangler.jsonc` as `DB`:
   ```bash
   cd apps/api
   pnpm exec wrangler d1 create uploads-production
   ```
3. Apply migrations locally during development:
   ```bash
   pnpm --filter @uploads/api run migrate:d1:local
   # equivalent: CI=1 wrangler d1 migrations apply DB --local  (from apps/api)
   ```
   Or run the full contributor setup from the monorepo root: `pnpm bootstrap`.
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
   pnpm run deploy:api   # runs migrate:d1 then wrangler deploy
   # or both workers:
   pnpm run deploy
   ```
   `deploy:api` always applies pending migrations first (binding `DB`,
   database `uploads-production`) so schema lands before new code. Manual-only:
   `pnpm --filter @uploads/api run migrate:d1`.

D1 owns short-lived legacy enrollment state, redemption, scoped/expiring
tokens, and the workspace usage ledger. KV remains the source of truth for
workspace storage configuration and legacy tokens. Never deploy a Worker that
reads a new D1 schema before the corresponding remote migration succeeds.
Check in every migration under `apps/api/migrations/`.

### The `apps/auth` worker

Sign-in (`uploads login`, `/admin`, `/accept-invitation`) is served by a
separate Better Auth worker, `apps/auth`, deploying to `auth.uploads.sh` with
its own D1 database (`uploads-auth`) and migrations under
`apps/auth/migrations/`. It needs a GitHub OAuth app, a signing secret, and
(for `apps/api` to verify sessions) a `services` binding named `AUTH` from
`apps/api` → the `uploads-auth` worker. See `apps/auth/README.md` for setup,
including the first-admin bootstrap.

### CI: migrations on merge

On push to `main` that touches `apps/api/migrations/**` (or the workflow /
API wrangler config), the **D1 Migrations** GitHub Actions workflow
(`.github/workflows/d1-migrations.yml`) runs
`wrangler d1 migrations apply DB --remote`. It needs repository secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (same as headless deploy;
token must be allowed to edit D1). Apply is replay-safe. You can also run the
workflow manually via **Actions → D1 Migrations → Run workflow**.

Workers Builds still deploys each app from its directory on push to main; if
the API build command is `pnpm run deploy` / `deploy:api`, migrations run in
that path too. Prefer **additive** migrations so “migrate then deploy” stays
safe; destructive changes need a deliberate reverse order and should not rely
on the default pipeline.

Use `pnpm run deploy`, not `pnpm deploy` — the bare form is pnpm's own
command.

## After wrangler.jsonc changes

Run `wrangler types` (or `pnpm --filter @uploads/api types`) so `Env` is
regenerated into `worker-configuration.d.ts`. Never hand-write that file.
