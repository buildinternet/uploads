# Local development

**Prerequisites:** Node ≥24 and pnpm ≥11 (`corepack enable`; versions pinned in
`package.json` / `.nvmrc`). No Cloudflare account is required for the core
local loop — `wrangler dev` simulates R2, KV, and D1 on disk.

```bash
pnpm bootstrap        # tooling, deps, API/Auth vars, types, local D1 migrations, default workspace
pnpm doctor           # diagnose the setup — reports what's missing and how to fix it

pnpm dev              # API on :8787 (local R2 + KV + D1)
pnpm dev:web          # Astro site
pnpm dev:stack        # authenticated Auth + API + Web stack (portless, see below)
pnpm dev:stack:check --json  # machine-readable readiness + session/API smoke proof
pnpm check            # lint + format (CI gate)
pnpm typecheck        # wrangler types + tsc across workspaces
```

## Named local URLs (portless)

`pnpm dev:stack` runs through [portless](https://npmjs.com/portless), so the
stack gets stable named `.localhost` origins instead of bare ports:

| Service | URL                              |
| ------- | -------------------------------- |
| web     | `https://uploads.localhost`      |
| auth    | `https://auth.uploads.localhost` |
| api     | `https://api.uploads.localhost`  |

The shared `.uploads.localhost` parent is what makes local auth work like
prod: the Better Auth session cookie set by the auth worker is sent to web
and api the same way `.uploads.sh` cookies are, so signed-in pages
(`/account/*`, `/admin/*`) just work in a local browser — including agent
browser panels. In a linked git worktree, portless prefixes the branch name
(`fix-ui.uploads.localhost` / `fix-ui.auth.uploads.localhost`); the cookie
parent still anchors on the last two labels, so nothing else changes.
`dev:stack` prints the resolved `previewUrl` when ready, and
`pnpm dev:stack:check --json` reports it too.

Notes:

- First run may prompt for sudo so the proxy can bind :443 (HTTPS). If sudo
  is unavailable, portless falls back to plain HTTP on `:1355` — the stack
  handles both. `pnpm exec portless doctor` diagnoses routing/CA issues, and
  `pnpm exec portless service install` keeps the proxy across reboots.
- `PORTLESS=0 pnpm dev:stack` restores the legacy pinned loopback ports
  (`127.0.0.1:4321/8787/8788`). This is also the path to use when testing the
  dev GitHub OAuth app, whose callback is pinned to
  `http://127.0.0.1:8788/api/auth/callback/github`.
- The zero-input `/api/auth/dev-session` bypass stays fail-closed: it only
  enables for the exact loopback pair or a matched `*.localhost` pair — never
  for real-TLD origins.

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
