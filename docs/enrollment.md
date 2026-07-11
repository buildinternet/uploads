# Invitations and `uploads login`

Early adopters authenticate through short-lived invitation codes. They never receive
the API's `ADMIN_TOKEN`. An administrator authorizes an existing workspace, shares the
single-use code, and the adopter runs `uploads login` to exchange it for a scoped,
expiring workspace token.

## Agent login

Install once for repeated use:

```bash
npm install --global @buildinternet/uploads
uploads login
uploads doctor
```

Or run it once without a global install:

```bash
npx @buildinternet/uploads login
```

Interactive login prompts without echoing the enrollment code. For automation, use an
ephemeral environment value rather than putting the code in shell history or the
process list:

```bash
UPLOADS_ENROLLMENT_CODE=upe_<workspace>_… uploads login
```

On success, the CLI saves `UPLOADS_API_URL`, `UPLOADS_WORKSPACE`, and
`UPLOADS_TOKEN` in the shared buildinternet config and runs `doctor`. It never prints
the raw workspace token. Use `--force` only when intentionally replacing an existing
configured token.

## Administrator: create an invitation

Enrollment creation remains behind `ADMIN_TOKEN`; only an administrator runs this
request. Do not paste the admin credential into agent prompts, configuration, issues,
or shell commands shared with an agent.

```bash
curl -X POST https://api.uploads.sh/admin/enrollments \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"default","label":"codex-cli","enrollmentSeconds":600,"tokenExpiresInSeconds":7776000,"scopes":["files:read","files:write"]}'
```

The admin CLI provides the same operation:

```bash
ADMIN_TOKEN=<admin-credential> uploads admin invite create \
  --workspace default --label codex-cli
```

`ADMIN_TOKEN` is the primary environment name used by the existing API and admin
workflow. `UPLOADS_ADMIN_TOKEN` may be accepted as a compatibility alias. Neither
belongs in routine-agent configuration.

The response includes a non-secret onboarding URL such as
`https://uploads.sh/invite?id=upi_…` and shows the invitation code once. Send them as
separate fields. The URL exposes only expiry and used status; it cannot mint credentials.
The code expires after 10 minutes and is consumed by a successful exchange. Invalid, expired, and consumed codes receive the same public error shape. The invite page is
served without analytics or third-party assets and requests `no-store`, `no-referrer`, and
`noindex` handling so the code never needs to appear in a URL.

Enrollment creation accepts `files:delete` only when the administrator explicitly
includes it in `scopes`. Keep the default read/write scopes for routine agents;
reserve delete for short-lived maintenance or smoke-test credentials that clean up
their own objects.

## Token policy

Enrollment-issued tokens default to:

- 90-day lifetime;
- `files:read` for list and metadata operations;
- `files:write` for uploads;
- no `files:delete` unless explicitly authorized.

The API stores token hashes, scopes, labels, creation time, and expiry—not raw tokens.
Revocation continues to use the admin token-list and revoke endpoints. Existing tokens
without scopes or expiry remain valid with their legacy access until deliberately
rotated or revoked.

## D1 state and deployment

D1 stores enrollment requests and every new scoped/expiring token, and guarantees
atomic single-use redemption. `REGISTRY` KV retains workspace storage configuration
and legacy tokens. Create and migrate the database before deploying enrollment-aware
API code:

```bash
cd apps/api
pnpm exec wrangler d1 create uploads-production
pnpm exec wrangler d1 migrations apply DB --local
pnpm exec wrangler d1 migrations apply DB --remote
# or: pnpm --filter @uploads/api run migrate:d1
```

Bind the database as `DB` in `apps/api/wrangler.jsonc`. Commit migrations under
`apps/api/migrations/`; remote apply runs via `deploy:api`, the **D1 Migrations**
GitHub Action on merge to main, or `migrate:d1` manually. See [deploy](deploy.md).

## Migration and future auth

Enrollment is additive: existing direct-minted and workspace-bootstrap tokens continue
to authenticate. New installations should use `uploads login`; direct token minting is
reserved for CI and break-glass administration. Rotate legacy routine-agent tokens to
scoped enrollment tokens gradually, then revoke the old hashes.

Better Auth with D1 and its API Key and Device Authorization plugins remains a later
migration path when uploads.sh has human accounts, organization membership, and an
authenticated browser approval UI. The current D1 schema and explicit workspace/token
boundary keep that migration possible without coupling storage configuration to an
identity framework today.
