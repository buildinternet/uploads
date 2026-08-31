/**
 * AS-side seam for authorize/consent/token-code scope rewrite.
 *
 * `@better-auth/oauth-provider` has no per-authorize scope hook and rejects
 * the whole authorize when the request asks for a scope the client is not
 * registered for. Generic MCP clients copy `scopes_supported` (and extras
 * such as `openid`) into `scope=`. RFC 6749 §3.3 lets the AS ignore
 * requested scopes it will not grant: downscope to the intersection with
 * the client's registered list, and only `invalid_scope` when nothing
 * grantable remains.
 *
 * Known ids stay in lockstep with `OAUTH_SCOPES` in auth.ts (duplicated
 * rather than imported: auth.ts wires this module from `hooks.before`).
 */
const KNOWN_SCOPES: ReadonlySet<string> = new Set([
  "files:read",
  "files:write",
  "files:delete",
  "offline_access",
]);

/**
 * Issue #911: the plugin only issues a refresh token when the grant carries
 * `offline_access`, but MCP clients build `scope=` from the resource
 * metadata's `scopes_supported` (files:* only) and so never request it.
 * Union it in server-side for any client registered with it — but only when
 * the filtered request still grants a real resource scope, so a
 * nothing-grantable request keeps its RFC 6749 §3.3 `invalid_scope` and an
 * offline_access-only grant can't be minted from garbage.
 */
const OFFLINE_ACCESS = "offline_access";

function filterScopeString(scope: string, allowedScopes: readonly string[]): string | undefined {
  const requested = scope.split(/\s+/).filter(Boolean);
  const allow = new Set(allowedScopes);
  let permitted = requested.filter((id) => KNOWN_SCOPES.has(id) && allow.has(id));
  const grantsResourceScope = permitted.some((id) => id !== OFFLINE_ACCESS);
  if (!grantsResourceScope) {
    // An offline_access-only request must not survive: it would mint a
    // refresh-token-only grant with no resource access. Dropping it lands in
    // the plugin's invalid_scope path like any other nothing-grantable request.
    permitted = [];
  } else if (allow.has(OFFLINE_ACCESS) && !permitted.includes(OFFLINE_ACCESS)) {
    permitted.push(OFFLINE_ACCESS);
  }
  const next = permitted.join(" ");
  return next === requested.join(" ") ? undefined : next;
}

/** Rewrite `query.scope` for `/oauth2/authorize`. Undefined when unchanged. */
export function restrictOAuthQueryScopes(
  query: Record<string, unknown> | undefined,
  allowedScopes: readonly string[],
): Record<string, unknown> | undefined {
  if (!query || typeof query.scope !== "string") return undefined;
  const next = filterScopeString(query.scope, allowedScopes);
  if (next === undefined) return undefined;
  return { ...query, scope: next };
}

function paramsFromOAuthQuery(oauthQuery: unknown): URLSearchParams | undefined {
  if (typeof oauthQuery !== "string" || !oauthQuery) return undefined;
  try {
    return new URLSearchParams(oauthQuery.startsWith("?") ? oauthQuery.slice(1) : oauthQuery);
  } catch {
    return undefined;
  }
}

function scopeFromOAuthQuery(oauthQuery: unknown): string | undefined {
  const scope = paramsFromOAuthQuery(oauthQuery)?.get("scope");
  return scope && scope.length > 0 ? scope : undefined;
}

/** `client_id` on an authorize query object. */
export function oauthClientIdFromQuery(
  query: Record<string, unknown> | undefined,
): string | undefined {
  const id = query?.client_id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** `client_id` on a consent body (`client_id` or the signed `oauth_query`). */
export function oauthClientIdFromConsentBody(
  body: Record<string, unknown> | undefined,
): string | undefined {
  const direct = oauthClientIdFromQuery(body);
  if (direct) return direct;
  const id = paramsFromOAuthQuery(body?.oauth_query)?.get("client_id");
  return id && id.length > 0 ? id : undefined;
}

/** `client_id` inside an authorization-code verification blob. */
export function oauthClientIdFromAuthorizationCode(value: string | undefined): string | undefined {
  const parsed = parseAuthorizationCode(value);
  return parsed ? oauthClientIdFromQuery(parsed.query) : undefined;
}

/**
 * Rewrite `/oauth2/consent`. The plugin persists `body.scope` if present,
 * otherwise the signed query's full list — so when the body omitted
 * `scope`, inject a filtered list from `oauth_query`.
 */
export function restrictOAuthConsentBody(
  body: Record<string, unknown> | undefined,
  allowedScopes: readonly string[],
): Record<string, unknown> | undefined {
  if (!body) return undefined;
  const source =
    typeof body.scope === "string" ? body.scope : scopeFromOAuthQuery(body.oauth_query);
  if (source === undefined) return undefined;
  const next = filterScopeString(source, allowedScopes);
  if (next === undefined) return undefined;
  return { ...body, scope: next };
}

function parseAuthorizationCode(
  value: string | undefined,
): { record: Record<string, unknown>; query: Record<string, unknown> } | undefined {
  if (typeof value !== "string" || !value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.type !== "authorization_code") return undefined;
  const query = record.query;
  if (query == null || typeof query !== "object" || Array.isArray(query)) return undefined;
  return { record, query: query as Record<string, unknown> };
}

/** Rewrite an authorization-code blob so token exchange cannot issue disallowed scopes. */
export function restrictAuthorizationCodeValue(
  value: string | undefined,
  allowedScopes: readonly string[],
): string | undefined {
  const parsed = parseAuthorizationCode(value);
  if (!parsed) return undefined;
  const { record, query } = parsed;
  if (typeof query.scope !== "string") return undefined;
  const next = filterScopeString(query.scope, allowedScopes);
  if (next === undefined) return undefined;
  return JSON.stringify({ ...record, query: { ...query, scope: next } });
}
