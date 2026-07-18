# Admin tokens

`ADMIN_TOKEN` is a break-glass ops/CI credential — it is **not** how someone
gets onto a workspace day-to-day. The normal path is a session-authenticated
organization invitation sent from the `/admin` UI, followed by the invitee
running `uploads login` themselves (see [enrollment](enrollment.md)).
`ADMIN_TOKEN` stays reserved for things the session-authed admin UI doesn't
cover: minting or revoking tokens on behalf of a workspace, the second-admin
promote fallback, credential re-encryption, org backfills, and CI smoke
tests. The workspace must already exist (`pnpm workspace:add …`).

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

Direct minting is retained for CI, migration, and break-glass use. Everyday
setup should use `uploads login` instead (see [enrollment](enrollment.md)) —
end users mint their own token that way, with no `ADMIN_TOKEN` involved.

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

## Operator scopes

Better-auth admins can also mint their own workspace tokens with opt-in
`admin:read` / `admin:write` scopes via the session-authed `POST /v1/tokens`
(no `ADMIN_TOKEN` involved). `admin:write` is a superset of `admin:read`.
Tokens carrying either scope are accepted by `/admin/*` alongside
`ADMIN_TOKEN`, and are revoked or listed the same way as any other token —
via the `GET`/`DELETE /admin/tokens` endpoints above. Although an operator
token is minted against (and stored under) a specific workspace, the
`admin:read` / `admin:write` scopes themselves grant global operator
authority across all of `/admin/*` — the same reach as `ADMIN_TOKEN` — not
just admin access scoped to that one workspace; the workspace only anchors
where the token is stored and which workspace's token list it appears
under for revocation.
