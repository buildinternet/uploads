/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * uploads.sh's API and hosted MCP server are OAuth *resource servers*: they
 * accept opaque per-workspace bearer tokens (`Authorization: Bearer up_<ws>_…`)
 * with `files:*` scopes. This document lets an agent discover that scheme
 * programmatically. It is served at `/.well-known/oauth-protected-resource`
 * on each resource origin (api.uploads.sh, agents.uploads.sh).
 *
 * `authorization_servers` is deliberately omitted. There is no public OAuth
 * authorization server for third-party clients — tokens are minted out-of-band
 * via `uploads login` (a first-party device flow) and the token-mint endpoint,
 * all described in `resource_documentation` (auth.md). Advertising an
 * `authorization_servers` entry would point RFC 9728 clients at an
 * authorization-server metadata document that we intentionally do not publish,
 * so we leave it out rather than dangle a broken reference. See auth.md's
 * "What we deliberately do not publish".
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
}

export function protectedResourceMetadata(opts: {
  resource: string;
  resourceName: string;
  webOrigin: string;
}): ProtectedResourceMetadata {
  return {
    resource: opts.resource,
    resource_name: opts.resourceName,
    scopes_supported: [...FILE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${opts.webOrigin.replace(/\/$/, "")}/auth.md`,
  };
}

/** Scheme + host of the incoming request — the resource identifier we advertise. */
export function requestOrigin(url: string): string {
  return new URL(url).origin;
}
