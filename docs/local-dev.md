# Local development

**Prerequisites:** Node ≥24 and pnpm ≥11 (`corepack enable`; versions pinned in
`package.json` / `.nvmrc`). No Cloudflare account is required for the core
local loop — `wrangler dev` simulates R2, KV, and D1 on disk.

```bash
pnpm bootstrap        # tooling, deps, API/Auth vars, types, local D1 migrations, default workspace
pnpm doctor           # diagnose the setup — reports what's missing and how to fix it

pnpm dev              # API on :8787 (local R2 + KV + D1)
pnpm dev:web          # Astro site
pnpm dev:stack        # authenticated Auth + API + Web stack, ready at 127.0.0.1:4321
pnpm dev:stack:check --json  # machine-readable readiness + session/API smoke proof
pnpm check            # lint + format (CI gate)
pnpm typecheck        # wrangler types + tsc across workspaces
```

`bootstrap` is idempotent (safe to re-run; never overwrites your env files or
re-mints an existing local workspace) and `doctor` is read-only. `dev:stack`
uses the real Workers, Better Auth cookie, service binding, membership checks,
and local R2; it starts an ordinary `dev-demo` member and nested PNG fixtures.
Stop it with <kbd>Ctrl-C</kbd>; the supervisor reaps every Worker/miniflare
process group.

## Manual setup

Prefer the manual steps over `bootstrap`?

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set ADMIN_TOKEN to any non-empty string
cp apps/auth/.dev.vars.example apps/auth/.dev.vars # set a 32+ character BETTER_AUTH_SECRET_DEV
cp .env.example .env                               # point UPLOADS_API_URL at http://127.0.0.1:8787
pnpm types
pnpm --filter @uploads/api run migrate:d1:local
pnpm --filter @uploads/auth run migrate:d1:local
pnpm workspace:add default --local                 # prints a bearer token once — save to .env
pnpm dev
```

## Smoke test

Upload a file (with `UPLOADS_TOKEN` from the workspace seed in the environment
or `.env`):

```bash
curl -X PUT http://127.0.0.1:8787/v1/default/files/test.txt \
  -H "Authorization: Bearer $UPLOADS_TOKEN" \
  -H "Content-Type: text/plain" \
  --data-binary "hello"
```

Agent and contributor conventions live in [AGENTS.md](../AGENTS.md).
Deployment is covered in [deploy.md](deploy.md); post-deploy smoke checks in
[contract-testing.md](contract-testing.md).
