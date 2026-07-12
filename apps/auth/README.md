# @uploads/auth

Dedicated Better Auth worker for uploads.sh (`auth.uploads.sh`). GitHub OAuth +
magic-link sign-in, its own D1 database (`uploads-auth`), and a small
`/internal/*` API reachable only via the `AUTH` service binding from
`apps/api`. See `docs/superpowers/plans/2026-07-12-better-auth-introduction.md`
for the full design.

The Better Auth Infrastructure dashboard (`@better-auth/infra` `dash()`) mounts
when `UPL_BETTER_AUTH_API_KEY` or local `BETTER_AUTH_API_KEY` resolves. Point the
project at `https://auth.uploads.sh`.

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
