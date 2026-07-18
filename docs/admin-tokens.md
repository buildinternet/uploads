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
`operator:read` / `operator:write` scopes via the session-authed `POST /v1/tokens`
(no `ADMIN_TOKEN` involved). `operator:write` is a superset of `operator:read`.
Tokens carrying either scope are accepted by `/admin/*` alongside
`ADMIN_TOKEN`, and are revoked or listed the same way as any other token —
via the `GET`/`DELETE /admin/tokens` endpoints above. Although an operator
token is minted against (and stored under) a specific workspace, the
`operator:read` / `operator:write` scopes themselves grant global operator
authority across all of `/admin/*` — the same reach as `ADMIN_TOKEN` — not
just operator access scoped to that one workspace; the workspace only anchors
where the token is stored and which workspace's token list it appears
under for revocation.

Note that a token minted with an operator scope gets **no** file-route access,
even if file scopes were also requested alongside it — scope parsing on the
file routes fails the whole scope array when it contains any non-file
scope. Mint a separate files-only token for file operations and a
dedicated operator token for `/admin/*`.

## Workspace-governance scopes

Org admins/owners can also mint tokens with opt-in `workspace:invite` /
`workspace:manage` scopes via the same session-authed `POST /v1/tokens` —
requesting either scope requires the minting session user to hold org role
`admin` or `owner` in the target workspace (platform-admin/operator status
does not bypass this check); otherwise the mint request is rejected with
`400 invalid_scopes`. Unlike operator scopes, workspace-governance scopes are
strictly **workspace-bounded**: a token only authorizes actions on the
workspace embedded in it (`up_<workspace>_…`), never any other workspace.

Like operator tokens, a workspace-governance token gets **zero** file-route
access, even if file scopes are requested alongside it — scope parsing on the
file routes fails the whole array when it contains any non-file scope. Mint a
separate files-only token for file operations.

- `workspace:invite` authorizes `POST /v1/workspaces/:name/invites` — sends an
  organization invite for workspace `:name`, mirroring the session-authed
  invite endpoint. The invite is attributed to the token's minting user, and
  the auth worker re-checks that user's org role at invite time, so a token
  minted by a since-demoted admin can no longer invite.
- `workspace:manage` authorizes `GET`/`DELETE /v1/workspaces/:name/tokens` —
  list (redacted: labels, scopes, created/expiry, hash prefix, never the
  token value) and revoke tokens belonging to workspace `:name`, mirroring the
  `GET`/`DELETE /admin/tokens` contract above. These routes also accept a
  plain session with org role `admin`/`owner` in `:name` as an alternative to
  a `workspace:manage` token.
