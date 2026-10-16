/**
 * Unauthenticated RFC 7591 Dynamic Client Registration (DCR) and CIMD posture.
 *
 * Open DCR stays on so MCP Inspector / Claude / Cursor / opencode can
 * self-register. That path must never mint a confidential or skip-consent
 * client: force public PKCE, strip first-party metadata, and drop
 * `client_credentials`. The MCP scope ceiling
 * (`OAUTH_CLIENT_REGISTRATION_DEFAULT_SCOPES` ∪ `ALLOWED`) is unchanged —
 * this module does not cap or rewrite `scope`.
 *
 * Applied in two places:
 *  - `hooks.before` on `/oauth2/register` ({@link sanitizeDcrRegistrationBody})
 *    so the plugin never sees privileged metadata;
 *  - after a successful register ({@link clampDcrRegistrationResult}) so a
 *    plugin default or ignored field cannot persist a secret or skip_consent.
 *
 * CIMD ingest runs {@link sanitizeCimdMetadataDocument} on the fetched
 * document. It is the DCR policy plus one exception: a CIMD document may keep
 * `private_key_jwt` when its `jwks_uri` is HTTPS and on the same origin as the
 * `client_id` URL (Vercel Connect, which ignores discovery and always signs a
 * `client_assertion`). The client controls that origin, so a key published
 * there proves nothing beyond what the `client_id` URL already does, and no
 * secret is ever stored. Every other CIMD document gets the DCR policy.
 * First-party seeded clients (`uploads-cli`, `releases-sh`) and admin /
 * internal provisioning do not go through this path.
 *
 * Discovery advertises `["none", "private_key_jwt"]` (`rewriteDiscoveryEndpoints`
 * in `index.ts`). DCR still coerces `client_secret_*` (and any other
 * unrecognized method) to `none` rather than rejecting: MCP clients advertise
 * `client_secret_basic` and then authenticate with PKCE, and the 201 body
 * reports `none`. DCR rejects `private_key_jwt` with `invalid_client_metadata`
 * ({@link dcrRegistrationRejection}): a DCR `jwks_uri` has no origin to bind
 * it to, and a key-holding client that picked the method from discovery
 * would otherwise be downgraded and then fail at the token endpoint
 * (`client is not registered for private_key_jwt authentication`).
 */

/**
 * Privileged / first-party metadata a DCR or CIMD body must never carry.
 * `skip_consent` is also ZodNever on Better Auth 1.7's DCR schema, so a
 * register body that still has it 400s before this strip runs. Keep the
 * field here for CIMD ingest and if that validation order ever changes.
 */
const STRIP_REGISTRATION_FIELDS = [
  "skip_consent",
  "trusted",
  "require_pkce",
  "client_credentials_scopes",
  "client_secret",
  "jwks",
  "jwks_uri",
  // The operator-only `official` flag lives in the row's metadata JSON and
  // drives the consent page's Verified badge. Better Auth 1.7 does not copy
  // register-body extras into metadata, but strip both spellings anyway so a
  // plugin change cannot let a self-registered client mark itself official.
  "official",
  "metadata",
] as const;

/** Grants an open-DCR / CIMD client may advertise. No `client_credentials` (M2M). */
export const DCR_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

const DCR_GRANT_SET: ReadonlySet<string> = new Set(DCR_GRANT_TYPES);

/**
 * Cap advertised `grant_types` for a self-registered client. With
 * `authorization_code` present, keep only the DCR set. Without it, only drop
 * `client_credentials` and leave the rest: the plugin then rejects the
 * remainder (an empty list, or only grants it does not issue) instead of
 * persisting an M2M-only client. `client_credentials` never survives either
 * way, whatever the auth method. `undefined` = not an array (plugin default
 * is `authorization_code`).
 */
function capDcrGrantTypes(grantTypes: unknown): unknown[] | undefined {
  if (!Array.isArray(grantTypes)) return undefined;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const grant of grantTypes) {
    if (typeof grant !== "string" || !DCR_GRANT_SET.has(grant) || seen.has(grant)) continue;
    seen.add(grant);
    next.push(grant);
  }
  if (next.includes("authorization_code")) return next;
  return grantTypes.filter((grant) => grant !== "client_credentials");
}

/** True when the capped grants still leave this client an authorization_code flow. */
function allowsAuthorizationCode(grantTypes: unknown): boolean {
  const capped = capDcrGrantTypes(grantTypes);
  return capped === undefined || capped.includes("authorization_code");
}

function grantTypesUnchanged(advertised: unknown, next: readonly unknown[]): boolean {
  return (
    Array.isArray(advertised) &&
    advertised.length === next.length &&
    advertised.every((grant, i) => grant === next[i])
  );
}

type SelfRegisteredAuthMethod = "none" | "private_key_jwt";

/**
 * Shared strip/cap pass. `private_key_jwt` keeps `jwks_uri` (the caller has
 * already checked it); every other privileged field is removed either way.
 */
function sanitizeSelfRegisteredBody(
  body: Record<string, unknown>,
  authMethod: SelfRegisteredAuthMethod,
): Record<string, unknown> | undefined {
  let next: Record<string, unknown> = body;
  let changed = false;

  if (body.token_endpoint_auth_method !== authMethod) {
    next = { ...next, token_endpoint_auth_method: authMethod };
    changed = true;
  }

  for (const field of STRIP_REGISTRATION_FIELDS) {
    if (authMethod === "private_key_jwt" && field === "jwks_uri") continue;
    if (field in next) {
      if (next === body) next = { ...next };
      delete next[field];
      changed = true;
    }
  }

  const nextGrants = capDcrGrantTypes(next.grant_types);
  if (nextGrants && !grantTypesUnchanged(next.grant_types, nextGrants)) {
    next = { ...next, grant_types: nextGrants };
    changed = true;
  }

  return changed ? next : undefined;
}

/**
 * Force a DCR body (or a CIMD document that does not qualify for
 * `private_key_jwt`) onto the public-PKCE policy.
 * `undefined` means the document already matches and can be left as posted.
 * Does not touch `scope`.
 */
export function sanitizeDcrRegistrationBody(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // Coerce instead of `invalid_client_metadata`. A hard reject would turn
  // away clients that already register with `client_secret_basic` and then
  // use PKCE. DCR's one hard reject (`private_key_jwt`) runs before this, in
  // dcrRegistrationRejection.
  return sanitizeSelfRegisteredBody(body, "none");
}

/**
 * The `jwks_uri` a CIMD document may keep for `private_key_jwt`, or
 * `undefined` when the document does not qualify. Qualifies only when the
 * document declares `private_key_jwt`, has no inline `jwks`, and `jwks_uri`
 * is an `https:` URL with no credentials or fragment on the exact origin of
 * `clientIdUrl` (the URL the document was fetched from). Inline `jwks` is
 * refused because the key would then live in our row instead of at the
 * client's origin, and a refresh could not rotate it.
 */
export function cimdPrivateKeyJwtJwksUri(
  doc: Record<string, unknown>,
  clientIdUrl: string,
): string | undefined {
  if (doc.token_endpoint_auth_method !== "private_key_jwt") return undefined;
  if (doc.jwks !== undefined) return undefined;
  const jwksUri = doc.jwks_uri;
  if (typeof jwksUri !== "string" || jwksUri.includes("#")) return undefined;
  let jwks: URL;
  let clientId: URL;
  try {
    jwks = new URL(jwksUri);
    clientId = new URL(clientIdUrl);
  } catch {
    return undefined;
  }
  if (jwks.protocol !== "https:" || clientId.protocol !== "https:") return undefined;
  if (jwks.username || jwks.password) return undefined;
  if (jwks.origin !== clientId.origin) return undefined;
  return jwksUri;
}

/**
 * CIMD ingest policy for a fetched metadata document. Keeps `private_key_jwt`
 * + `jwks_uri` only when {@link cimdPrivateKeyJwtJwksUri} accepts it; any
 * other document (including `private_key_jwt` with a cross-origin, `http:`,
 * or inline key) falls back to the DCR public-PKCE policy instead of being
 * rejected, so the client can still finish an authorization_code + PKCE
 * flow. Either way: no secret, no `client_credentials`, no skip_consent.
 * Re-run on every metadata refresh, so a document that moves its `jwks_uri`
 * off-origin is downgraded to `none` on the next resolution.
 */
export function sanitizeCimdMetadataDocument(
  doc: Record<string, unknown>,
  clientIdUrl: string,
): Record<string, unknown> | undefined {
  // A key is only worth keeping for a client that will run the consented
  // authorization_code flow; anything else (e.g. client_credentials-only)
  // takes the public path, where the plugin rejects the leftover grants.
  if (
    cimdPrivateKeyJwtJwksUri(doc, clientIdUrl) === undefined ||
    !allowsAuthorizationCode(doc.grant_types)
  ) {
    return sanitizeDcrRegistrationBody(doc);
  }
  return sanitizeSelfRegisteredBody(doc, "private_key_jwt");
}

/**
 * DCR-only hard reject. `undefined` means the body may proceed to
 * {@link sanitizeDcrRegistrationBody}. `private_key_jwt` is refused because
 * discovery now lists it (for CIMD) and a DCR `jwks_uri` has no `client_id`
 * origin to bind to; coercing it to `none` would leave a key-holding client
 * sending assertions that the token endpoint rejects.
 */
export function dcrRegistrationRejection(body: Record<string, unknown>): string | undefined {
  if (body.token_endpoint_auth_method !== "private_key_jwt") return undefined;
  return "private_key_jwt is supported only for Client ID Metadata Document clients; register with token_endpoint_auth_method none and use PKCE";
}

/**
 * Row fix-ups after Better Auth creates or refreshes a CIMD row. `undefined`
 * means the row is already right.
 *
 * - `requirePKCE: true`: ingest strips `require_pkce`, so the plugin stores
 *   null. `isPKCERequired` reads null as required, but the row should say so
 *   explicitly rather than lean on that default.
 * - `jwks`/`jwksUri: null` when the client is not `private_key_jwt`: a
 *   refresh skips fields the document no longer has, so a client downgraded
 *   from `private_key_jwt` would keep its old `jwks_uri`. The token endpoint
 *   ignores it (assertions need `private_key_jwt`), but the row should not
 *   claim a key it will never use.
 */
export function cimdClientRowFixups(client: {
  tokenEndpointAuthMethod?: string | null;
  requirePKCE?: boolean | null;
  jwks?: unknown;
  jwksUri?: string | null;
}): { requirePKCE?: true; jwks?: null; jwksUri?: null } | undefined {
  const patch: { requirePKCE?: true; jwks?: null; jwksUri?: null } = {};
  if (client.requirePKCE !== true) patch.requirePKCE = true;
  if (
    client.tokenEndpointAuthMethod !== "private_key_jwt" &&
    (client.jwks != null || client.jwksUri != null)
  ) {
    patch.jwks = null;
    patch.jwksUri = null;
  }
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** Persistable client-row fields the after-register clamp writes. */
export type DcrClientRowPatch = {
  skipConsent: false;
  tokenEndpointAuthMethod: "none";
  public: true;
  requirePKCE: true;
  clientCredentialsScopes: null;
  clientSecret: null;
  jwks: null;
  jwksUri: null;
};

/**
 * Patch applied to a just-registered DCR row. First-party flags, secrets,
 * and M2M ceilings are cleared. Scopes are left alone.
 */
export function dcrClientRowPatch(): DcrClientRowPatch {
  return {
    skipConsent: false,
    tokenEndpointAuthMethod: "none",
    public: true,
    requirePKCE: true,
    clientCredentialsScopes: null,
    clientSecret: null,
    jwks: null,
    jwksUri: null,
  };
}

/**
 * Mutate a successful `/oauth2/register` JSON result so the 201 body cannot
 * leak a `client_secret` or advertise skip_consent/trusted. Returns the
 * `client_id` so the caller can persist {@link dcrClientRowPatch} on the
 * matching row. Leaves `APIError` / `Response` / non-objects alone
 * (`undefined`). Does not rewrite `scope`.
 */
export function clampDcrRegistrationResult(returned: unknown): string | undefined {
  if (returned == null || typeof returned !== "object") return undefined;
  // APIError extends Error; a raw Response is not client metadata.
  if (returned instanceof Error || returned instanceof Response) return undefined;
  const record = returned as Record<string, unknown>;
  const clientId = record.client_id;
  if (typeof clientId !== "string" || clientId.length === 0) return undefined;

  record.token_endpoint_auth_method = "none";
  delete record.client_secret;
  delete record.client_secret_expires_at;
  delete record.skip_consent;
  delete record.trusted;
  if (Array.isArray(record.grant_types)) {
    const grants = record.grant_types.filter(
      (grant): grant is string => typeof grant === "string" && grant !== "client_credentials",
    );
    if (!grantTypesUnchanged(record.grant_types, grants)) {
      record.grant_types = grants;
    }
  }
  return clientId;
}
