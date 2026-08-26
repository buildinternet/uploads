# Generic MCP client interop (CIMD + OAuth)

Playbook for this stack: one Better Auth OAuth 2.1 authorization server, [CIMD](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/02/) (and leftover DCR) client registration, RFC 8707 resource indicators, and a hosted MCP resource server at `agents.uploads.sh`.

The four failures below are the order a generic client (we used [MCPJam](https://www.mcpjam.com/)) hits them: ingest, authorize `scope=`, authorize `resource=`, then a tool that HTTP-fetches a sibling REST API. The first three apply here. The fourth does not: hosted MCP tools call `@uploads/api` in process, and `api.uploads.sh` does not accept OAuth JWTs.

Source for the pattern: [sunny/docs/mcp-cimd-interop.md](https://github.com/buildinternet/sunny/blob/main/docs/mcp-cimd-interop.md). Read this before changing discovery, implementing a grant this AS does not issue, or expanding CIMD default scopes.

## 1. `invalid_client_metadata` / unsupported `grant_type` `device_code`

**Error (AS, CIMD ingest):**

```json
{
  "error": "invalid_client_metadata",
  "error_description": "unsupported grant_type urn:ietf:params:oauth:grant-type:device_code"
}
```

**Why a generic client does it.** CIMD `grant_types` is a capability advertisement. MCPJam's document lists `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:device_code` because its CLI can run the device flow. The authorize URL it actually sends is a normal `response_type=code` + PKCE request. Same class: claude.ai adds `urn:ietf:params:oauth:grant-type:jwt-bearer`.

**Rule.** Intersect advertised grants with the grants oauth-provider issues. Ignore extras at ingest. Enforce at the token endpoint (`unsupported_grant_type`) if someone actually requests a grant you do not implement. Do not treat CIMD `grant_types` as a demand that you implement every listed grant.

**What we do.** `rewriteClientMetadataGrantTypes` in `apps/auth/src/cimd-transport.ts` rewrites fetched metadata, and `hooks.before` on `/oauth2/register` rewrites DCR bodies, so `grant_types` is the intersection with `authorization_code`, `refresh_token`, and `client_credentials` before the plugin parses it. Leave the document untouched if `authorization_code` would not remain: ingest still rejects a device-code-only client.

This worker does implement RFC 8628 for the seeded `uploads-cli` client (`deviceAuthorization()` in `apps/auth/src/auth.ts`). oauth-provider's CIMD/DCR ingest validator does not treat that plugin's grant as supported, so `device_code` stays out of the intersection list. Adding it there would persist it on CIMD rows and still fail ingest.

**Do not.** Add `device_code` or `jwt-bearer` to the CIMD supported-grant list without shipping that grant through oauth-provider. Do not implement RFC 8628 for CIMD clients just so the metadata document parses.

## 2. `invalid_scope` on authorize

**Error (AS, `/oauth2/authorize`):**

```
invalid_scope: The following scopes are invalid: openid, profile, admin
```

**Why a generic client does it.** RFC 9728 / AS metadata `scopes_supported` is the product's full list (`files:read`, `files:write`, `files:delete`). Generic clients copy that list into authorize `scope=` and often add extras (`openid`, `profile`). A CIMD document often has no `scope` field. Better Auth then rejects the entire authorize when the request is a superset of the registered list.

**Rule.** [RFC 6749 §3.3](https://datatracker.ietf.org/doc/html/rfc6749#section-3.3): the AS MAY ignore requested scopes it cannot or will not grant. Downscope to the client's registered list and drop unknown ids. Fail authorize only when nothing usable remains. Keep any future elevated scope per-client. Do not expand CIMD/DCR defaults to "every string a client might copy."

**What we do.** `apps/auth/src/oauth-grant-scopes.ts` intersects `scope=` with `oauth_client.scopes` (fallback: `OAUTH_SELF_REGISTERED_SCOPES` = default ∪ allowed, which today is all three `files:*` scopes) on authorize, consent, and the authorization-code blob. `files:delete` stays on `clientRegistrationAllowedScopes` so a self-registered client can still request it through consent. Discovery still lists all three in `scopes_supported`.

This product has no OAuth `admin` scope. The Sunny admin-strip does not apply.

**Do not.** Expand CIMD default scopes to whatever a client puts in `scope=`. Do not fail the whole authorize when a usable subset remains. Do not add a new elevated scope to `clientRegistrationAllowedScopes` without deciding it is CIMD-requestable.

## 3. `invalid_target` / requested resource not configured

**Error (AS, authorize):**

```
invalid_target: requested resource https://agents.uploads.sh is not configured
```

**Why a generic client does it.** RFC 9728 protected-resource metadata commonly advertises `resource` as the origin. Clients copy that string into authorize `resource=` (RFC 8707). This AS listed only the transport URL (`origin/mcp`) as a configured resource, because that is what the MCP server card and this worker's RFC 9728 document use (`resource: origin/mcp` in `apps/mcp/src/index.ts`).

**Rule.** Accept both the origin and the `/mcp` form for every MCP identifier the AS is willing to mint. The MCP resource server must accept both as JWT `aud`. Discovery can keep advertising `/mcp`. Clients that pass `resource=origin` must keep working, and so must clients that pass `origin/mcp`.

**What we do.** `mcpResourceAndOrigin` in `apps/auth/src/auth.ts` (`oauthResources()`): for every MCP identifier that is `origin + /mcp` (canonical + the `mcp.uploads.sh` alias), also list the origin. `/mcp` stays. MCP JWT verification in `apps/mcp/src/index.ts` (`OAUTH_AUDIENCES`) lists the same four values. RFC 9728 on the MCP worker still advertises `origin/mcp`.

**Do not.** Change discovery to origin-only. Do not drop the `/mcp` form. Do not accept arbitrary `resource=` values.

## 4. REST 401 when an MCP tool forwards the Bearer

Does not apply. Hosted tools in `apps/mcp/src/tools.ts` import `@uploads/api` and use the worker's storage, D1, and GitHub bindings directly. They do not HTTP-fetch `api.uploads.sh` with the caller's access token. `api.uploads.sh` does not verify OAuth JWTs (see `apps/api/src/well-known.ts` and `apps/web/public/auth.md`).

If a later tool starts forwarding the Bearer to the REST API, the Sunny fix is: accept same-environment MCP origin and `/mcp` as JWT `aud` on every API gate that already verifies Bearer JWTs. Do not invent a second auth path for that route. Do not let a preview MCP token verify on prod.

## Hosted `/mcp` credentials

Hosted `/mcp` accepts an OAuth JWT or a workspace token (`up_<workspace>_…`). An API session cookie will 401 there. `uploads login`'s device flow is the CLI path for minting a workspace token; it is not the CIMD path.
