# Admin tokens

`ADMIN_TOKEN` is a server-administration credential. Routine agents must never
receive it. The normal onboarding path is for an administrator to create a
short-lived enrollment code and for the agent to exchange it with `uploads login`.
The workspace must already exist (`pnpm workspace:add …`).

## Setup

Set `ADMIN_TOKEN` once per environment:

```bash
# local: add ADMIN_TOKEN=... to apps/api/.dev.vars
# production:
cd apps/api && pnpm exec wrangler secret put ADMIN_TOKEN
```

The admin CLI reads `ADMIN_TOKEN` as its primary environment variable;
`UPLOADS_ADMIN_TOKEN` may be accepted as a compatibility alias. Do not place either
value in routine-agent configuration.

## Mint a token

Direct minting is retained for CI, migration, and break-glass use. Interactive and
routine agent setup should use [enrollment](enrollment.md) instead.

Defaults to the `default` workspace:

```bash
curl -XPOST https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → { "workspace": "default", "token": "up_default_…", "label": null }
```

A specific workspace, with an optional label:

```bash
curl -XPOST https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"acme","label":"ci"}'
```

The token is shown once. Minting appends — a workspace can hold several valid
tokens.

## List tokens

The raw token and full hash are never returned — only an 8-char `hashPrefix`,
which is the handle for revoke:

```bash
curl https://api.uploads.sh/admin/tokens?workspace=default \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# → { "workspace": "default", "tokens": [ { "label": "ci", "createdAt": "…", "hashPrefix": "a1b2c3d4" } ] }
```

## Revoke a token

By `hashPrefix` or `label`. A selector that matches no token is `404`; one
that matches more than one is `409` (pick a longer `hashPrefix`):

```bash
curl -XDELETE https://api.uploads.sh/admin/tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"workspace":"default","hashPrefix":"a1b2c3d4"}'
# or: -d '{"workspace":"default","label":"ci"}'
```
