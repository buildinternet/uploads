/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * uploads.sh's API and hosted MCP server are OAuth *resource servers*: they
 * accept opaque per-workspace bearer tokens (`Authorization: Bearer up_<ws>_…`)
 * with `files:*` scopes. This document lets an agent discover that scheme
 * programmatically. It is served at `/.well-known/oauth-protected-resource`
 * on each resource origin (api.uploads.sh, agents.uploads.sh).
 *
 * `authorization_servers` is opt-in per caller via `authorizationServers`
 * (issue #224). Only apps/mcp passes it — it's the only resource server that
 * verifies the uploads-auth OAuth JWTs (v1 is MCP-only; see
 * docs/superpowers/specs/2026-07-17-oauth-authorization-server-design.md).
 * apps/api's own usage keeps omitting it: tokens for the REST API are still
 * minted out-of-band via `uploads login` / the token-mint endpoint (described
 * in `resource_documentation`), and advertising an authorization server here
 * would point RFC 9728 clients at an AS that doesn't accept api.uploads.sh
 * audiences — a dangling, misleading reference. See auth.md's "What we
 * deliberately do not publish".
 */
import { FILE_SCOPES } from "./auth-db";

export interface ProtectedResourceMetadata {
  /** RFC 9728 resource identifier — the resource server this document describes. */
  resource: string;
  resource_name: string;
  /** Only `files:*` scopes carried by workspace tokens; single source of truth is FILE_SCOPES. */
  scopes_supported: string[];
  /** We only read the `Authorization` header — never a form body or query param. */
  bearer_methods_supported: string[];
  /** Human/agent-readable acquisition + usage docs (auth.md). */
  resource_documentation: string;
  /** Issuer URL(s) of the authorization server(s) that issue tokens for this resource. Omitted when the caller doesn't pass `authorizationServers`. */
  authorization_servers?: string[];
}

export function protectedResourceMetadata(opts: {
  resource: string;
  resourceName: string;
  webOrigin: string;
  /** Issuer(s) whose access tokens this resource server accepts. Leave unset to omit `authorization_servers` (the honest default — see module doc). */
  authorizationServers?: string[];
}): ProtectedResourceMetadata {
  return {
    resource: opts.resource,
    resource_name: opts.resourceName,
    scopes_supported: [...FILE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${opts.webOrigin.replace(/\/$/, "")}/auth.md`,
    ...(opts.authorizationServers ? { authorization_servers: opts.authorizationServers } : {}),
  };
}

/** Scheme + host of the incoming request — the resource identifier we advertise. */
export function requestOrigin(url: string): string {
  return new URL(url).origin;
}
