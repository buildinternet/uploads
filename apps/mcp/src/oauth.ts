/**
 * Resource-server verification of OAuth 2.1 access tokens minted by the
 * uploads-auth authorization server (issue #224). The MCP worker has no
 * service binding to apps/auth — it verifies JWTs locally with `jose`
 * against the AS's public JWKS, fetched over plain `fetch` and cached
 * in-isolate for a few minutes (mirrors sunny/apps/api/src/oauth-resource.ts,
 * adapted from a service-binding fetch to a real HTTP fetch since there's no
 * binding here).
 *
 * Token shape (see docs/superpowers/specs/2026-07-17-oauth-authorization-server-design.md):
 * issuer `${AUTH_ORIGIN}/api/auth`, `workspace` (primary slug, or null for a
 * user with none) and `workspaces` (all slugs) custom claims, and scopes in
 * the standard `scope` claim — handled defensively in case better-auth's
 * oauth-provider emits a `scopes` array instead (unverified at write time).
 */
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";

/**
 * The existing FILE_SCOPES ladder (apps/api/src/auth-db.ts), duplicated as a
 * literal here — same tradeoff the AS lane makes in apps/auth: this worker
 * doesn't otherwise need @uploads/api's auth-db module, and scopes are stable
 * enough that a values-only duplication (with a type-level cross-check) beats
 * pulling in the extra import surface.
 */
export const FILE_SCOPES = ["files:read", "files:write", "files:delete"] as const;
export type FileScope = (typeof FILE_SCOPES)[number];

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;

type JwksCache = { jwks: JSONWebKeySet; expiresAt: number };
let jwksCache: JwksCache | null = null;

/** Test-only: drop the per-isolate JWKS cache so a fresh fetcher re-resolves. */
export function resetOAuthJwksCacheForTests(): void {
  jwksCache = null;
}

/** Fetches a JWKS document from a URL. Overridable in tests to avoid network. */
export type JwksFetcher = (jwksUrl: string) => Promise<JSONWebKeySet>;

const defaultJwksFetcher: JwksFetcher = async (jwksUrl) => {
  const res = await fetch(jwksUrl);
  if (!res.ok) throw new Error(`jwks fetch failed: ${res.status}`);
  const body = (await res.json()) as JSONWebKeySet;
  if (!body || !Array.isArray(body.keys)) throw new Error("malformed jwks document");
  return body;
};

async function loadJwks(jwksUrl: string, fetcher: JwksFetcher): Promise<JSONWebKeySet | null> {
  const now = Date.now();
  if (jwksCache && now < jwksCache.expiresAt) return jwksCache.jwks;
  try {
    const jwks = await fetcher(jwksUrl);
    jwksCache = { jwks, expiresAt: now + JWKS_CACHE_TTL_MS };
    return jwks;
  } catch {
    return null;
  }
}

/**
 * Cheap routing check: does the credential look like a compact JWS (three
 * non-empty base64url segments)? `up_<workspace>_…` tokens never match (no
 * dots), so this decides the auth lane without validating the token.
 */
export function isJwtShaped(raw: string): boolean {
  const parts = raw.split(".");
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9_-]+$/.test(p));
}

/**
 * Extract FILE_SCOPES-ladder scopes from a verified payload. The AS emits a
 * space-delimited `scope` string per RFC 6749, but better-auth's
 * oauth-provider plugin behavior for `scope` vs. an array `scopes` claim
 * wasn't independently confirmed against a running 1.6.23 instance at write
 * time, so both shapes are read defensively; unknown scope strings are
 * dropped rather than passed through.
 */
export function extractFileScopes(payload: JWTPayload): FileScope[] {
  const record = payload as Record<string, unknown>;
  const raw = record.scope ?? record.scopes;
  let tokens: string[];
  if (typeof raw === "string") {
    tokens = raw.split(/\s+/).filter(Boolean);
  } else if (Array.isArray(raw)) {
    tokens = raw.filter((s): s is string => typeof s === "string");
  } else {
    tokens = [];
  }
  const seen = new Set<FileScope>();
  for (const t of tokens) {
    if ((FILE_SCOPES as readonly string[]).includes(t)) seen.add(t as FileScope);
  }
  return [...seen];
}

/** `workspace` (primary slug or null) and `workspaces` (all slugs) custom claims. */
function extractWorkspaceClaims(payload: JWTPayload): {
  workspace: string | null;
  workspaces: string[];
} {
  const record = payload as Record<string, unknown>;
  const workspace = typeof record.workspace === "string" ? record.workspace : null;
  const workspaces = Array.isArray(record.workspaces)
    ? record.workspaces.filter((w): w is string => typeof w === "string")
    : [];
  return { workspace, workspaces };
}

/** A successfully verified OAuth access token, projected to what MCP auth needs. */
export interface VerifiedOAuthToken {
  /** Primary workspace slug, or null when the user has no workspace yet. */
  workspace: string | null;
  /** All workspace slugs the token's user belongs to. */
  workspaces: string[];
  /** FILE_SCOPES-ladder scopes carried by the token. */
  scopes: FileScope[];
  /** The full verified payload, for callers that need other claims. */
  raw: JWTPayload;
}

export interface OAuthJwtConfig {
  /** Expected `iss` — `${AUTH_ORIGIN}/api/auth`. jose does an exact match. */
  issuer: string;
  /** Acceptable `aud` values — this resource's canonical URIs. */
  audience: string[];
  /** JWKS endpoint. Defaults to `${issuer origin}/api/auth/jwks`. */
  jwksUrl?: string;
  /** Test seam: skip the network fetch and cache, verify against this fetcher. */
  jwksFetcher?: JwksFetcher;
}

function defaultJwksUrl(issuer: string): string {
  return new URL("/api/auth/jwks", issuer).href;
}

/**
 * Verify an OAuth access-token JWT against the AS JWKS. Checks signature,
 * `iss`, `aud` (any of the configured audiences), and `exp` (jose enforces
 * expiry). Returns the projected token on success, `null` on ANY failure —
 * callers treat null exactly like an invalid opaque token. Never throws.
 */
export async function verifyOAuthJwt(
  token: string,
  config: OAuthJwtConfig,
): Promise<VerifiedOAuthToken | null> {
  try {
    const jwksUrl = config.jwksUrl ?? defaultJwksUrl(config.issuer);
    const fetcher = config.jwksFetcher ?? defaultJwksFetcher;
    const jwks = await loadJwks(jwksUrl, fetcher);
    if (!jwks) return null;
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: config.issuer,
      audience: config.audience,
    });
    const { workspace, workspaces } = extractWorkspaceClaims(payload);
    return {
      workspace,
      workspaces,
      scopes: extractFileScopes(payload),
      raw: payload,
    };
  } catch {
    return null;
  }
}

/** Origin (`scheme://host[:port]`) of a request URL — used to build the discovery challenge. */
function requestOriginOf(requestUrl: string): string {
  return new URL(requestUrl).origin;
}

/**
 * RFC 9728 §5.1 `WWW-Authenticate` challenge for an invalid/expired OAuth
 * JWT, pointing the client at this resource's protected-resource metadata so
 * a compliant MCP client can discover the AS and re-authenticate.
 */
export function wwwAuthenticateChallenge(requestUrl: string): string {
  const origin = requestOriginOf(requestUrl);
  return `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

/**
 * 401 for a request that presented no bearer credential at all. Per RFC 9728
 * §5.1 the challenge carries `resource_metadata` but NO `error` attribute
 * (RFC 6750 §3.1: `invalid_token` is only for a bad credential, not a missing
 * one). This is the response MCP clients bootstrap OAuth discovery from.
 */
export function missingTokenChallenge(requestUrl: string): Response {
  const origin = requestOriginOf(requestUrl);
  return new Response(
    JSON.stringify({
      error: {
        code: "unauthorized",
        type: "unauthorized",
        message: "Authentication required.",
      },
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
      },
    },
  );
}

/** 401 JSON response carrying the RFC 9728 discovery challenge for a bad JWT. */
export function invalidTokenChallenge(requestUrl: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "invalid_token",
        type: "unauthorized",
        message: "The access token is invalid or expired.",
      },
    }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": wwwAuthenticateChallenge(requestUrl),
      },
    },
  );
}
