/**
 * Workers fetch transport for CIMD metadata documents (issue #556).
 *
 * `@better-auth/cimd` requires the application to supply the transport that
 * fetches Client ID Metadata Documents, and states the contract in Node
 * terms: resolve DNS once, reject RFC 6890 special-use addresses, pin the
 * approved address for the connection, and never follow redirects. The
 * package's own `@better-auth/cimd/node` transport implements that with
 * `node:dns` + `node:https`, neither of which exists on Cloudflare Workers.
 *
 * This transport provides the equivalent guarantees at the Workers network
 * boundary instead:
 *
 * - **Special-use hosts rejected up front** — literal-IP and special-use
 *   FQDN targets (loopback, RFC 1918, link-local/IMDS, cloud-metadata
 *   FQDNs, …) are rejected via the plugin's own `validateClientIdUrl`
 *   (draft-02 §3), backed by the same RFC 6890 classifier the Node
 *   transport runs against resolved addresses.
 * - **No rebinding surface behind a public hostname** — Workers outbound
 *   `fetch` egresses from Cloudflare's edge, where RFC 1918 / link-local
 *   space is not routable to anything of ours: every uploads service is a
 *   Worker/R2/D1 reached via bindings, not IP. A hostname that resolves to
 *   a private address yields a connection error, not an internal service.
 *   (Cloudflare additionally blocks subrequests into its own metadata
 *   endpoints.) DNS resolution and connection reuse are the edge's; there
 *   is no socket API with which to resolve-then-pin ourselves.
 * - **Redirects returned, never followed** — `redirect: "manual"`.
 * - **GET/HEAD only, HTTPS only** — same method/scheme gate as the Node
 *   transport.
 *
 * The plugin has already run `validateClientIdUrl` on the `client_id` URL
 * before fetching; the checks here also cover discovery-owned follow-up
 * fetches such as a confidential client's `jwks_uri`.
 */
import { validateClientIdUrl } from "@better-auth/cimd";
import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";

/**
 * Grants this AS's oauth-provider token endpoint actually issues. Matches
 * `@better-auth/oauth-provider`'s default set. CIMD `grant_types` is a
 * capability advertisement, not a demand that we implement every listed
 * grant: MCPJam includes `device_code` and claude.ai includes `jwt-bearer`
 * on a normal authorization_code + PKCE authorize URL.
 *
 * `@better-auth/cimd` 1.7 has no option to ignore extras, so the transport
 * intersects fetched metadata (and DCR POST /oauth2/register, via the
 * rewrite helper) with this list before the plugin parses it.
 *
 * `urn:ietf:params:oauth:grant-type:device_code` is intentionally absent.
 * This worker does implement RFC 8628 for the seeded `uploads-cli` client
 * (`deviceAuthorization()`), but oauth-provider's CIMD/DCR ingest validator
 * does not treat that plugin's grant as supported. Adding it here would
 * persist it on CIMD rows and still fail ingest. Do not add `jwt-bearer`
 * without shipping that grant.
 */
export const AS_SUPPORTED_GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
  "client_credentials",
] as const;

const AS_SUPPORTED_GRANT_TYPE_SET: ReadonlySet<string> = new Set(AS_SUPPORTED_GRANT_TYPES);

/** Plugin body cap is 5 KiB; skip the JSON rewrite above that. */
const CIMD_METADATA_REWRITE_MAX_BYTES = 5 * 1024;

/**
 * Intersect advertised CIMD/DCR `grant_types` with {@link AS_SUPPORTED_GRANT_TYPES}.
 *
 * Returns the supported subset (order preserved, duplicates dropped) when
 * `authorization_code` remains. Returns `undefined` when the value is
 * missing, malformed, or has no usable grant, so the caller leaves the
 * document alone and the plugin still rejects an unsupported-only list.
 */
export function intersectAdvertisedGrantTypes(grantTypes: unknown): string[] | undefined {
  if (!Array.isArray(grantTypes)) return undefined;
  const supported: string[] = [];
  const seen = new Set<string>();
  for (const grant of grantTypes) {
    if (typeof grant !== "string" || !AS_SUPPORTED_GRANT_TYPE_SET.has(grant) || seen.has(grant)) {
      continue;
    }
    seen.add(grant);
    supported.push(grant);
  }
  if (!supported.includes("authorization_code")) return undefined;
  return supported;
}

function grantTypesUnchanged(advertised: unknown, next: string[]): boolean {
  return (
    Array.isArray(advertised) &&
    advertised.length === next.length &&
    advertised.every((grant, i) => grant === next[i])
  );
}

/**
 * Drop unsupported `grant_types` from a parsed metadata document or DCR body.
 * `undefined` means leave the document as fetched.
 */
export function rewriteClientMetadataGrantTypes(
  metadata: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const next = intersectAdvertisedGrantTypes(metadata.grant_types);
  if (next === undefined || grantTypesUnchanged(metadata.grant_types, next)) {
    return undefined;
  }
  return { ...metadata, grant_types: next };
}

function shouldRewriteMetadataBody(res: Response): boolean {
  if (res.status !== 200) return false;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CIMD_METADATA_REWRITE_MAX_BYTES) {
    return false;
  }
  const contentType = res.headers.get("content-type") ?? "";
  return contentType === "" || /json/i.test(contentType);
}

async function rewriteFetchedMetadataGrantTypes(res: Response): Promise<Response> {
  if (!shouldRewriteMetadataBody(res)) return res;

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  const rewritten = rewriteClientMetadataGrantTypes(parsed as Record<string, unknown>);
  if (!rewritten) {
    return new Response(text, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  const body = JSON.stringify(rewritten);
  const headers = new Headers(res.headers);
  headers.set("content-length", String(new TextEncoder().encode(body).byteLength));
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

export const fetchClientMetadataResource: ClientMetadataResourceFetch = async (input, init) => {
  // The plugin calls this with `redirect: "error"`, which workerd's Request
  // constructor REJECTS outright ("won't be implemented... use manual and
  // check the response status"). Pin "manual" at construction time — the
  // plugin already treats any non-200 (including 3xx) as a failed fetch, so
  // returned redirects are refused either way. Caught in prod smoke, not by
  // vitest: Node's undici accepts `redirect: "error"`.
  const request = new Request(input, { ...init, redirect: "manual" });
  const url = new URL(request.url);
  if (url.protocol !== "https:") {
    throw new TypeError("CIMD Workers transport requires an HTTPS URL");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new TypeError("CIMD Workers transport supports only GET and HEAD");
  }
  // draft-02 §3 URL validation (loopback/private/link-local/cloud-metadata
  // hosts all rejected). The plugin runs this on the client_id URL before
  // resolving; re-running it here also covers discovery-owned follow-up
  // fetches such as a confidential client's `jwks_uri`.
  const urlError = validateClientIdUrl(request.url);
  if (urlError) {
    throw new TypeError(`metadata URL rejected: ${urlError}`);
  }
  const res = await fetch(request);
  return rewriteFetchedMetadataGrantTypes(res);
};
