# @uploads/auth

Dedicated Better Auth worker for uploads.sh. GitHub OAuth + magic-link
sign-in, its own D1 database (`uploads-auth`), and a small `/internal/*` API
reachable only via the `AUTH` service binding from `apps/api`. See
`docs/superpowers/plans/2026-07-12-better-auth-introduction.md` for the full
design.

The browser never calls this worker directly: `apps/web` proxies
`/api/auth/*` to it over the `AUTH` service binding, so it's served to
browsers same-origin at `https://uploads.sh/api/auth/*` (the OAuth issuer and
discovery live there too). `auth.uploads.sh` is this worker's own deploy
target and direct machine origin — used for CLI device/bearer flows and
internal service-binding calls, not for browser traffic.

The Better Auth Infrastructure dashboard (`@better-auth/infra` `dash()`) mounts
when `BETTER_AUTH_API_KEY` resolves (plain secret; a transitional
`UPL_BETTER_AUTH_API_KEY` Secrets Store fallback still exists — see
src/secrets.ts and uploads#754 item 2). Point the project's Base URL at
`https://uploads.sh` with Base Path `/api/auth`.

## First admin

No one has the global `admin` role (Better Auth's `admin` plugin) until you
grant it. Primary path — after the first human signs in, run:

```bash
wrangler d1 execute uploads-auth --remote --command \
  "UPDATE user SET role = 'admin' WHERE email = 'someone@example.com';"
```

See `scripts/promote-admin.sql` for the checked-in reference. Fallback: `POST
/admin/users/promote` on `apps/api` (`ADMIN_TOKEN`-gated), which proxies to
this worker's `/internal/promote-admin` over the service binding — useful
when D1 console access is inconvenient.
