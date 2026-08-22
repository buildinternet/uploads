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
  return fetch(request);
};
