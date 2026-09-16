/**
 * Unauthenticated RFC 7591 Dynamic Client Registration (DCR) posture.
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
 * CIMD ingest reuses {@link sanitizeDcrRegistrationBody} on the fetched
 * document. First-party seeded clients (`uploads-cli`, `releases-sh`) and
 * admin / internal provisioning do not go through this path.
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
] as const;

/** Grants an open-DCR / CIMD client may advertise. No `client_credentials` (M2M). */
export const DCR_GRANT_TYPES = ["authorization_code", "refresh_token"] as const;

const DCR_GRANT_SET: ReadonlySet<string> = new Set(DCR_GRANT_TYPES);

function capDcrGrantTypes(grantTypes: unknown): string[] | undefined {
  if (!Array.isArray(grantTypes)) return undefined;
  const next: string[] = [];
  const seen = new Set<string>();
  for (const grant of grantTypes) {
    if (typeof grant !== "string" || !DCR_GRANT_SET.has(grant) || seen.has(grant)) continue;
    seen.add(grant);
    next.push(grant);
  }
  if (!next.includes("authorization_code")) return undefined;
  return next;
}

function grantTypesUnchanged(advertised: unknown, next: string[]): boolean {
  return (
    Array.isArray(advertised) &&
    advertised.length === next.length &&
    advertised.every((grant, i) => grant === next[i])
  );
}

/**
 * Force a DCR / CIMD body onto the public-PKCE policy.
 * `undefined` means the document already matches and can be left as posted.
 * Does not touch `scope`.
 */
export function sanitizeDcrRegistrationBody(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let next: Record<string, unknown> = body;
  let changed = false;

  if (body.token_endpoint_auth_method !== "none") {
    next = { ...next, token_endpoint_auth_method: "none" };
    changed = true;
  }

  for (const field of STRIP_REGISTRATION_FIELDS) {
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
