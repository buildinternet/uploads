# Agent enrollment and `uploads login`

Routine agents authenticate through short-lived enrollment codes. They never receive
the API's `ADMIN_TOKEN`. An administrator authorizes an existing workspace, shares the
single-use code, and the agent runs `uploads login` to exchange it for a scoped,
expiring workspace token.

## Agent login

Install once for repeated use:

```bash
npm install --global @buildinternet/uploads
uploads login
uploads doctor
```

Or use a pinned package without a global install:

```bash
npx @buildinternet/uploads@0.1.0 login
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

## Administrator: create an enrollment

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
ADMIN_TOKEN=<admin-credential> uploads admin enrollment create \
  --workspace default --label codex-cli
```

`ADMIN_TOKEN` is the primary environment name used by the existing API and admin
workflow. `UPLOADS_ADMIN_TOKEN` may be accepted as a compatibility alias. Neither
belongs in routine-agent configuration.

The response shows the enrollment code once. Transfer only that code to the routine
agent. It expires after 10 minutes and is consumed by a successful exchange. Invalid,
expired, and consumed codes receive the same public error shape.

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
pnpm exec wrangler d1 migrations apply uploads-production --local
pnpm exec wrangler d1 migrations apply uploads-production --remote
```

Bind the database as `DB` in `apps/api/wrangler.jsonc`. Commit migrations, apply
the remote migration first, and deploy the API only after it succeeds. See
[deploy](deploy.md) for the complete ordering.

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
