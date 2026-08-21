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

| Service | URL                              | Browser-visible?                                            |
| ------- | -------------------------------- | ----------------------------------------------------------- |
| web     | `https://uploads.localhost`      | yes — the only origin the browser talks to                  |
| auth    | `https://auth.uploads.localhost` | no — internal upstream behind web's `/api/auth` proxy       |
| api     | `https://api.uploads.localhost`  | not yet (phase D moves browser api traffic same-origin too) |

All three processes still run — auth and api each get their own named origin
— but since #731 phase C the browser only ever talks to `uploads.localhost`:
auth is served same-origin through web's `/api/auth` proxy (mirroring
production), so `auth.uploads.localhost` is now an internal upstream the web
worker forwards to, not something a signed-in page's own requests hit
directly. The Better Auth session cookie is host-only on `uploads.localhost`
(no shared `.uploads.localhost` parent needed anymore — same shape as prod's
host-only `uploads.sh` cookie), and signed-in pages (`/account/*`, `/admin/*`)
just work in a local browser, including agent browser panels. In a linked git
worktree, portless prefixes the branch name (`fix-ui.uploads.localhost` /
`fix-ui.auth.uploads.localhost` for the internal upstream); nothing else
changes. `dev:stack` prints the resolved `previewUrl` when ready, and
`pnpm dev:stack:check --json` reports it too.

Notes:

- First run may prompt for sudo so the proxy can bind :443 (HTTPS). If sudo
  is unavailable, portless falls back to plain HTTP on `:1355` — the stack
  handles both. `pnpm exec portless doctor` diagnoses routing/CA issues, and
  `pnpm exec portless service install` keeps the proxy across reboots.
- `pnpm dev:stack:raw` (or `PORTLESS=0 pnpm dev:stack`) restores the legacy
  pinned loopback ports (`127.0.0.1:4321/8787/8788`) — same-origin mode there
  too (the auth worker's `BETTER_AUTH_URL` is set to the web origin,
  `http://127.0.0.1:4321`, even though the worker process itself still
  listens on its own pinned `:8788`). This raw mode is also the path to use
  when testing the dev GitHub OAuth app, whose callback is pinned to
  `http://127.0.0.1:8788/api/auth/callback/github` — note that pinned
  callback is now a DIFFERENT origin than `BETTER_AUTH_URL`
  (`http://127.0.0.1:4321`), so Better Auth's derived `redirect_uri` won't
  match it; day-to-day GitHub sign-in testing should stay on the
  `dev-session` bypass below, or temporarily point `BETTER_AUTH_URL` back at
  `http://127.0.0.1:8788` (see `apps/auth/.dev.vars.example`) to exercise the
  real GitHub OAuth flow. The `stack-raw` launch config (.claude/launch.json)
  boots the same thing with a port-based preview; in portless mode the web
  port is dynamic, so open the printed `previewUrl` directly instead.
- `pnpm dev:stack:oauth` is the named alias for the real-TLD mode below.
- The zero-input `/api/auth/dev-session` bypass stays fail-closed: it only
  enables for a recognized local-stack web-origin shape (the exact loopback
  pair or a matched `*.localhost` origin) — never for real-TLD origins, even
  when they happen to be same-origin.

### Real-TLD mode for OAuth (`*.uploads.local.buildinternet.dev`)

Some OAuth providers (Google, Apple) reject `*.localhost` redirect URIs, so
the stack can run under a real TLD instead — on the shared
`local.buildinternet.dev` infra zone, same as the sibling repos:

```bash
PORTLESS_TLD=dev PORTLESS_NAME=uploads.local.buildinternet pnpm dev:stack
# -> https://uploads.local.buildinternet.dev
#    https://auth.uploads.local.buildinternet.dev
#    https://api.uploads.local.buildinternet.dev
```

The zone is deliberately NOT under uploads.sh: prod sets its session cookie
with `Domain=.uploads.sh`, so a `local.uploads.sh` zone would leak prod
cookies into local dev stacks (and let local software set cookies scoped to
prod). The infra domain has no production cookies to overlap.

DNS: `local.buildinternet.dev` + `*.local.buildinternet.dev` are public
DNS-only A records → `127.0.0.1` (never proxy them), so the names resolve to
loopback on any machine, worktree prefixes included.
`pnpm exec portless hosts sync` is only a fallback for offline work.

The proxy only serves TLDs it was started with, so if yours runs with the
default `.localhost` only, this mode auto-starts a second proxy on `:1355`
and the URLs carry that port. For clean port-free URLs, run one proxy with
both TLDs: `sudo portless proxy stop && sudo portless proxy start --https
--tld localhost --tld dev` (or bake it in with
`portless service install --tld localhost --tld dev`).

These origins are trusted by the auth worker outside production (https only).
Same-origin mode applies here too (`BETTER_AUTH_URL` is the web origin), so
register the provider's redirect URI as
`https://uploads.local.buildinternet.dev/api/auth/callback/<provider>` — NOT
the `auth.` subdomain, even though that's where the auth worker's own process
listens; `auth.uploads.local.buildinternet.dev` is now only the internal
upstream web forwards `/api/auth/*` to.
Note the `dev-session` bypass is intentionally unavailable in this mode —
sign in through the real provider flow you're testing. GitHub accepts
loopback callbacks, so day-to-day GitHub testing can stay on `PORTLESS=0`
instead.

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
