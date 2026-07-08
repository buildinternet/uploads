# Admin tokens

Upload tokens are minted by an admin endpoint guarded by the `ADMIN_TOKEN`
secret. The workspace must already exist (`pnpm workspace:add …`); this
endpoint issues tokens, it does not create workspaces.

## Setup

Set `ADMIN_TOKEN` once per environment:

```bash
# local: add ADMIN_TOKEN=... to apps/api/.dev.vars
# production:
cd apps/api && pnpm exec wrangler secret put ADMIN_TOKEN
```

## Mint a token

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
