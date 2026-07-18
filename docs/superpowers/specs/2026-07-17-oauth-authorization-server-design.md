# OAuth 2.1 authorization server for agents.uploads.sh (issue #224)

Status: approved design, implementing on `claude/oauth-agents-implementation-0fefce`.

## Goal

Stand up an OAuth 2.1 authorization server on the existing `uploads-auth` worker
(`auth.uploads.sh`) so the hosted MCP server at `agents.uploads.sh/mcp` can
authenticate through a browser flow — no env var, no baked token, no local CLI.
Acceptance (from #224): a fresh Claude Code user installs the plugin and the
hosted MCP authenticates via OAuth; the bundled `.mcp.json` switches back to the
hosted HTTP endpoint.

## Approach

Follow the pattern proven in the sibling repos (`~/Code/releases`,
`~/Code/sunny`), both on Better Auth 1.6.23 with `@better-auth/oauth-provider`:

- **AS**: `jwt()` + `oauthProvider()` plugins added to the existing
  `betterAuth()` config in `apps/auth/src/auth.ts` (jwt registered **before**
  oauthProvider — it signs access tokens and serves JWKS at
  `/api/auth/jwks`). Issuer is `${BETTER_AUTH_URL}/api/auth`
  (`https://auth.uploads.sh/api/auth`).
- **Tokens**: JWT access tokens verified **statelessly** by resource servers
  against the AS JWKS — no AUTH service binding added to `apps/mcp`. This is
  the JWKS path the Better Auth introduction plan (D1, lines 108–110) already
  reserved.
- **Workspace mapping**: `customAccessTokenClaims` queries the auth D1
  (`member` ⋈ `organization`, same database) and embeds the user's workspace
  slugs: `workspaces: [...]` plus a primary `workspace` (oldest membership) the
  MCP worker uses. Zero workspaces → claims still issue; the MCP worker
  responds 403 with a create-a-workspace message.
- **Scopes**: the existing `FILE_SCOPES` — `files:read`, `files:write`,
  `files:delete` (duplicated as a literal in `apps/auth`; no dependency on
  `@uploads/api`). DCR default scopes: `files:read files:write`.
- **DCR**: `allowDynamicClientRegistration` + unauthenticated registration on,
  rate-limited (5/min, D1-backed), with a stale-client reaper added to the
  existing `15 6 * * *` cron (copy `sunny/apps/auth/src/oauth-client-reaper.ts`).
- **Discovery**: root aliases on the auth worker —
  `/.well-known/oauth-authorization-server` (+ `/*` path-inserted form, RFC
  8414) and `/.well-known/openid-configuration` — rewritten to the Better Auth
  handler, `Access-Control-Allow-Origin: *`.
- **RFC 9728**: `protectedResourceMetadata` in `apps/api/src/well-known.ts`
  gains an `authorizationServers` option. Only `apps/mcp` advertises it (it's
  the only origin that accepts the JWTs in v1); `apps/api` keeps omitting it —
  honest metadata. Tests updated accordingly.
- **Resource server** (`apps/mcp`): bearer path multiplexes credential types —
  JWT-shaped tokens (two dots) verify via `jose` against
  `https://auth.uploads.sh/api/auth/jwks` (issuer + audience checked, JWKS
  cached ~5 min in-isolate), everything else falls through to the existing
  `up_` workspace-token path. Valid JWT → same context vars
  (workspace/scopes) the existing auth sets. Invalid → 401 +
  `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="…"`.
  Accepted audiences: `https://agents.uploads.sh/mcp`,
  `https://mcp.uploads.sh/mcp` (mirrored into the AS `validAudiences`).
- **Web UI** (`apps/web`, Astro, dependency-free client):
  - `/oauth/consent` page modeled on `device.astro`: fetches
    `/api/auth/oauth2/public-client?client_id=…`, shows scopes, POSTs
    `/api/auth/oauth2/consent` with `accept` + `oauth_query`
    (= `location.search` minus `?`), follows `redirect_uri`.
  - Login resume: the plugin sends unauthenticated users to
    `login?<signed query>`. The client contract is simply to inject
    `oauth_query` into sign-in POST bodies when `location.search` carries
    `sig=` — added to `auth-client.ts`; the server resumes the authorize flow
    (including through magic-link and GitHub redirects).
- **Plugin**: `plugins/claude/uploads/.mcp.json` switches back to the hosted
  HTTP endpoint `https://agents.uploads.sh/mcp`.
- **Docs**: `apps/web/public/auth.md` + web README lose the "no public OAuth
  AS" claim and document the new AS.

## Out of scope / deferred

- OAuth JWT acceptance on `api.uploads.sh` (v1 is MCP-only).
- A workspace picker at consent for multi-workspace users (v1: oldest
  membership wins; all slugs are in the token for a future picker).
- Third-party client management UI. DCR + consent is the only client surface.
- The `uploads-cli` device flow is untouched.

## Data / migrations

New tables in the `uploads-auth` D1, hand-synced schema + timestamped SQL
migration (repo convention, fake-D1 tests apply real migrations):
`oauth_client`, `oauth_access_token`, `oauth_refresh_token`, `oauth_consent`,
`jwks` — copied from `sunny/apps/auth/src/schema.ts:239-336` and its
`oauth_provider` migration. Post-merge operational step: `wrangler d1
migrations apply DB --remote` for `uploads-auth`.

## Testing

- `apps/auth`: fake-D1 tests — discovery metadata served at root aliases, DCR
  registers a client, authorize→consent→token round-trip issues a JWT carrying
  workspace claims, JWKS endpoint serves keys.
- `apps/mcp`: sign a JWT with a test key, serve a fake JWKS, assert the MCP
  auth path accepts it (and rejects bad iss/aud/exp) and that
  `oauth-protected-resource` now advertises `authorization_servers`.
- `apps/api`: `well-known.test.ts` keeps asserting the API resource omits
  `authorization_servers`.
