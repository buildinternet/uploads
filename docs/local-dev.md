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

`pnpm dev:stack` runs through [portless](https://npmjs.com/portless) on the
shared `local.buildinternet.dev` infra zone, same as the sibling repos. WEB
gets a stable named HTTPS origin instead of a bare port. Google and Apple
reject `*.localhost` redirect URIs; this hostname is a real Public Suffix
domain that they accept.

| Service | URL                                       | Browser-visible?                                      |
| ------- | ----------------------------------------- | ----------------------------------------------------- |
| web     | `https://uploads.local.buildinternet.dev` | yes — the only origin the browser talks to            |
| auth    | plain loopback (dynamic)                  | no — internal upstream behind web's `/api/auth` proxy |
| api     | plain loopback (dynamic)                  | no — internal upstream behind web's `/api` proxy      |

The name and TLD live in the repo (`portless.json` plus `PORTLESS_TLD=dev` on
`dev:stack`). You do not set `PORTLESS_NAME` in a local env file. A short
name under `--tld dev` would be `uploads.dev`, which can collide with a real
domain.

Since #731 the browser only ever talks to that web origin: auth and api
are served same-origin through web's `/api/auth` and `/api` proxies (mirroring
production), so they're internal upstreams the web worker forwards to, not
origins a signed-in page's own requests hit. Because nothing browser-facing
needs their hostnames, only WEB gets a portless-named origin; auth and api run
as plain `127.0.0.1` loopback processes on ports assigned dynamically at boot
(so concurrent worktree stacks don't collide). The Better Auth session cookie
is host-only on the web origin (same shape as prod's host-only `uploads.sh`
cookie), and signed-in pages (`/account/*`, `/admin/*`) just work in a local
browser, including agent browser panels. In a linked git worktree, portless
prefixes the branch name (`fix-ui.uploads.local.buildinternet.dev`); nothing
else changes. `dev:stack` prints the resolved `previewUrl` when ready, and
`pnpm dev:stack:check --json` reports it too.

The zone is deliberately not under uploads.sh. Prod's session cookie is
host-only on `uploads.sh`, and keeping local dev off that host means a local
stack never shares an origin with production. DNS:
`local.buildinternet.dev` + `*.local.buildinternet.dev` are public DNS-only
A records → `127.0.0.1` (never proxy them), so the names resolve to loopback
on any machine, worktree prefixes included.
`pnpm exec portless hosts sync` is only a fallback for offline work.

Register OAuth redirect URIs on the web origin:
`https://uploads.local.buildinternet.dev/api/auth/callback/<provider>`.
Auth has no named subdomain — it is a loopback upstream that web forwards
`/api/auth/*` to. `pnpm dev:stack:oauth` is an alias of `pnpm dev:stack`.

The zero-input `/api/auth/dev-session` bypass stays fail-closed: it only
enables for a recognized local-stack web-origin shape (the pinned loopback
stack, a leftover `*.localhost` origin, or this owned zone). It never
enables for `uploads.dev` or other unrelated real TLDs.

Notes:

- First run may prompt for sudo so the proxy can bind :443 (HTTPS). If sudo
  is unavailable, portless falls back to plain HTTP on `:1355` — the stack
  handles both. `pnpm exec portless doctor` diagnoses routing/CA issues.
  The shared proxy should serve TLD `dev`
  (`portless service install --tld dev`), matching the other repos. If the
  proxy is still `.localhost` only, restart it with `--tld dev` so the
  default hostname does not fall through to a second proxy on `:1355`.
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
cp apps/auth/.dev.vars.example apps/auth/.dev.vars # set a 32+ character BETTER_AUTH_SECRET
cp .env.example .env                               # point UPLOADS_API_URL at http://127.0.0.1:8787
pnpm types
pnpm --filter @uploads/api run migrate:d1:local    # single merged chain — includes auth's tables (#754 item 1)
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

## Verifying the screenshots page with real thumbnails

`/account/workspaces/[name]/screenshots` needs a signed-in session, fixture
uploads, and a place to actually serve their bytes from — none of which the
smoke test above sets up. This recipe uses the raw loopback stack
(`pnpm dev:stack:raw`, or `pnpm dev` + `pnpm dev:auth` + `pnpm dev:web`
separately) so thumbnail bytes can come from a loopback `publicBaseUrl`.
`pnpm dev:stack` also enables the `dev-session` bypass on
`https://uploads.local.buildinternet.dev`. A few steps here aren't obvious
from the API alone:

1. **Sign in with the `dev-session` bypass, from a page already on
   `http://127.0.0.1:4321`.** The endpoint
   (`POST /api/auth/dev-session`, `apps/auth/src/local-demo.ts`) checks the
   request's `Origin` header against `WEB_ORIGIN` exactly, so it only works
   called from a page already loaded there — not from a bare `curl`. It also
   only exists when local-demo mode is enabled. Send a JSON body, even an
   empty one: better-call 415s a POST with no `Content-Type: application/json`,
   the same gotcha `signOut` documents in `apps/web/src/lib/auth-client.ts`.

   ```js
   // from the browser console on http://127.0.0.1:4321
   await fetch("http://127.0.0.1:8788/api/auth/dev-session", {
     method: "POST",
     credentials: "include",
     headers: { "Content-Type": "application/json" },
     body: "{}",
   });
   ```

2. **Register a workspace with a loopback `publicBaseUrl`, and serve those
   bytes yourself.** `GET /public/files/:workspace/:key` returns JSON
   metadata, not image bytes, so it can't be the thumbnail source. Use a
   fresh workspace name rather than re-registering `default` —
   `workspace:add` always mints a new token and would invalidate the one
   `bootstrap` already seeded for you — and point it at a plain static file
   server:

   ```bash
   pnpm workspace:add shots-demo --local --public-base-url http://127.0.0.1:8090
   # serve fixture bytes at http://127.0.0.1:8090/shots-demo/screenshots/...
   npx http-server ./fixtures-root -p 8090
   ```

   Lay fixture bytes out under `fixtures-root/<workspace>/<key>` — a
   shared-mode workspace's public URL is `publicBaseUrl/<workspace>/<key>`
   (`packages/storage/src/index.ts`'s `publicUrl`), so a `screenshots/app-a/…`
   key needs to exist at `fixtures-root/shots-demo/screenshots/app-a/…`.

   This alone isn't enough to make the page render actual `<img>` tiles,
   though: a loopback `publicBaseUrl` isn't one of the CDN hosts the API
   auto-derives an embeddable URL for (`DEFAULT_EMBEDDABLE_HOSTS` in
   `packages/storage/src/index.ts` only knows `storage.uploads.sh` /
   `store.uploads.sh`), so `embedUrl` comes back `null` and the tile falls
   back to its generic file icon. Self-host the embed twin by pointing it at
   the same static server in `apps/api/.dev.vars`:

   ```
   EMBED_PUBLIC_BASE_URL=http://127.0.0.1:8090
   ```

3. **Upload fixtures under an allowed key prefix.** `pnpm workspace:add`
   applies the shared/agent limit template by default, which restricts
   `allowedKeyPrefixes` to `f/`, `screenshots/`, and `gh/`
   (`apps/api/src/key-policy.ts`). A key outside those roots fails with
   `key_prefix_not_allowed`, so fixture keys need a `screenshots/` prefix.
   The page also only lists files carrying `path` metadata, set via an
   `X-Uploads-Meta-path` header — `$SHOTS_DEMO_TOKEN` is the token
   `workspace:add` printed in the previous step:

   ```bash
   curl -X PUT http://127.0.0.1:8787/v1/shots-demo/files/screenshots/app-a/hero.png \
     -H "Authorization: Bearer $SHOTS_DEMO_TOKEN" \
     -H "Content-Type: image/png" \
     -H "X-Uploads-Meta-path: /dashboard" \
     -H "X-Uploads-Meta-app: app-a" \
     --data-binary @fixtures/app-a.png
   ```

   Give each project fixture its own bytes: a put whose body hash matches an
   object the workspace already holds inherits that object's derived
   metadata, `path` included (content-hash inheritance,
   `apps/api/src/content-hash.ts`). Reusing the same PNG for two "projects"
   silently collapses them into one label — generate distinct pixels per
   fixture (even a 1px color change is enough).

4. **Expect thumbnails only in `astro dev`, never a prod-style build.**
   Signed-in pages' CSP only relaxes `img-src` for loopback origins when
   `import.meta.env.DEV` is true (`apps/web/src/lib/signed-in-page.ts`) — a
   built/deployed page blocks a loopback image source on purpose, so this
   whole recipe only proves out under `pnpm dev:web` (or `dev:stack:raw`),
   not a preview build.

Agent and contributor conventions live in [AGENTS.md](../AGENTS.md).
Deployment is covered in [deploy.md](deploy.md); post-deploy smoke checks in
[contract-testing.md](contract-testing.md).
