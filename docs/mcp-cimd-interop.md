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

**What we do.** `rewriteClientMetadataGrantTypes` in `apps/auth/src/cimd-transport.ts` rewrites fetched metadata, and `hooks.before` on `/oauth2/register` rewrites DCR bodies, so `grant_types` is the intersection with `authorization_code`, `refresh_token`, and `client_credentials` before the plugin parses it. Leave the document untouched if `authorization_code` would not remain: ingest still rejects a device-code-only client. Self-registered clients then lose `client_credentials` (see [DCR is public-only](#dcr-is-public-only)), whatever their token endpoint auth method.

Discovery advertises the grants a self-registered client can use: `authorization_code` and `refresh_token`. `rewriteDiscoveryEndpoints` drops `client_credentials` from `grant_types_supported`. The plugin still implements that grant, and a public client is rejected at the token endpoint (`public clients cannot use the client_credentials grant`). Vercel Connect maps the advertised grant to an app-subject token, which cannot succeed for a connector registered here.

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

## DCR is public-only

Open `/oauth2/register` stays on so MCP Inspector, Claude, and Cursor can self-register. That path must not persist a confidential client or mark one trusted. CIMD gets one exception, for `private_key_jwt`.

**What we do (DCR).** `sanitizeDcrRegistrationBody` on `/oauth2/register` forces `token_endpoint_auth_method: "none"`, strips `skip_consent` / `trusted` / inbound `client_secret` / `jwks` / `jwks_uri` / `client_credentials_scopes`, and drops `client_credentials`. An after-register clamp writes the same posture on the `oauth_client` row and removes any secret from the 201 JSON. The MCP scope ceiling does not change: defaults stay `files:read` + `files:write` + `offline_access`, and `files:delete` stays requestable through consent.

DCR rewrites `client_secret_basic`, `client_secret_post`, `client_secret_jwt`, and unknown methods to `none`. It does not return `invalid_client_metadata` for them. A client that advertises `client_secret_basic` and then uses PKCE still gets a 201, and the body reports `none`.

DCR rejects `private_key_jwt` with `invalid_client_metadata` (`dcrRegistrationRejection` in `apps/auth/src/oauth-dcr.ts`). Discovery lists that method for CIMD clients. A DCR `jwks_uri` has no `client_id` origin to bind to. If DCR rewrote the method to `none`, a client that holds a key would send a `client_assertion` and fail at the token endpoint (`client is not registered for private_key_jwt authentication`). The error at registration names the problem.

**What we do (CIMD).** `sanitizeCimdMetadataDocument` runs on every fetched metadata document, in `fetchClientMetadataResource` (`apps/auth/src/cimd-transport.ts`). It keeps `private_key_jwt` and `jwks_uri` only when all of these are true:

- The document declares `token_endpoint_auth_method: "private_key_jwt"`.
- The document has a `jwks_uri` and no inline `jwks`.
- `jwks_uri` is `https:`, has no credentials or fragment, and has the same origin as the URL the document was fetched from (the `client_id`).

- After `client_credentials` is removed, `grant_types` still allows `authorization_code` (or is omitted).

Any other document gets the DCR policy: the method becomes `none`, and `jwks` and `jwks_uri` are removed. A cross-origin, `http:`, or inline key does not cause a rejection. The client can still finish an authorization_code + PKCE flow as a public client. Public CIMD clients (Claude, Flowy) do not change. Both paths strip secrets, `skip_consent`, `trusted`, and `require_pkce`, and drop `client_credentials`. Every token still needs a user's consent through authorization_code.

Vercel Connect is the client that needs this. Its document declares `private_key_jwt` with a `jwks_uri` on `connect.vercel.com`, and it signs a `client_assertion` whatever discovery says.

At the token endpoint, oauth-provider's `verifyClientAssertion` fetches keys from the stored `jwks_uri` through the same CIMD transport (HTTPS only, no redirects, special-use hosts rejected). It checks the signature (asymmetric algorithms only), `iss` = `sub` = `client_id`, `aud`, `exp` (at most 300 s away), and single use of `jti` (the `oauth_client_assertion` table). Accepted `aud` values are the issuer, `https://uploads.sh/api/auth/oauth2/token`, and the same path on `AUTH_DIRECT_ORIGIN` (`https://auth.uploads.sh/api/auth/oauth2/token`), which is the advertised `token_endpoint`. The direct-origin form needs a local patch to oauth-provider (`clientAssertionAudienceOrigins` in `patches/@better-auth__oauth-provider.patch`). Without it, an assertion addressed to the advertised endpoint fails.

`client_credentials` is removed from every self-registered grant list. If no `authorization_code` remains, the rest of the list goes to the plugin unchanged, and the plugin rejects it (an empty list, or only grants it does not issue). A `client_credentials`-only document is never persisted.

The transport reads every JSON body with a byte cap (64 KiB, the JWKS limit), whatever `Content-Length` says, and throws past it. A metadata document over 5 KiB also throws, so an oversized document is never passed on unsanitized. A JWK Set is served from memory for 30 s per URL, so an assertion with an unknown `kid` cannot make every request fetch the client's `jwks_uri` again. A rotated key is picked up within that window.

PKCE stays required for a CIMD `private_key_jwt` client. Ingest removes `require_pkce` (the plugin forbids it in a document), and `onClientCreated` / `onClientRefreshed` then set the row's `requirePKCE` to `true` (`cimdClientRowFixups`). The plugin also rejects `require_pkce: false` on CIMD.

The nightly retention sweep (`apps/auth/src/retention-sweep.ts`) deletes `oauth_client_assertion` rows whose `exp` has passed.

On each refresh the resolver fetches the document again through the same transport, so the same rules apply. A document that moves its `jwks_uri` off the `client_id` origin drops to `none` on the next refresh, and `onClientRefreshed` clears the stored `jwks_uri`.

**Discovery.** `rewriteDiscoveryEndpoints` sets `token_endpoint_auth_methods_supported` to `["none", "private_key_jwt"]` and `grant_types_supported` to `authorization_code` and `refresh_token`. Better Auth 1.7's oauth-provider also lists `client_secret_basic`, `client_secret_post`, and `client_credentials`. This server does not store those methods or that grant for a DCR or CIMD client. A client that trusts the library's list registers for a method that fails, which is what Vercel Connect's Submit-a-Service user-token test hit (#1117). The same document's `client_credentials` entry is what Connect maps to an app token. `token_endpoint_auth_signing_alg_values_supported` is kept, because RFC 8414 requires it when a `*_jwt` method is listed. It holds the algorithms `verifyClientAssertion` accepts. `revocation_endpoint_auth_methods_supported` is also `["none", "private_key_jwt"]`, with its signing-algorithm list: the plugin accepts a bare `client_id` there for a public client and verifies an assertion for a `private_key_jwt` client. Introspection lists stay as the plugin emits them, because that endpoint requires a secret or an assertion. Seeded `uploads-cli` (device code) and `releases-sh` (authorization code) do not use this discovery list.

First-party seeded clients (`uploads-cli`, `releases-sh`) and admin provisioning are not this path.

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
