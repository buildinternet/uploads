/**
 * Where an OAuth grant's authorization code goes once the user clicks Allow.
 *
 * Self-registered (DCR / CIMD) clients choose their own `client_name`,
 * `logo_uri`, and `client_uri`, so none of those identify who receives the
 * code: a client can register as "Claude" with `client_uri: https://claude.ai`
 * and a redirect to its own server. The `redirect_uri` in the consent query
 * is the one value that decides the destination, and the AS signs it (the
 * consent POST fails if it is edited), so the consent page shows it.
 */
export type RedirectDestination =
  | { kind: "web"; host: string }
  | { kind: "local" }
  | { kind: "app"; scheme: string };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function describeRedirectDestination(
  redirectUri: string | null | undefined,
): RedirectDestination | null {
  if (!redirectUri) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (LOOPBACK_HOSTS.has(url.hostname)) return { kind: "local" };
    return url.host ? { kind: "web", host: url.host } : null;
  }
  // Private-use schemes (RFC 8252 §7.1), e.g. `cursor://` or `com.example.app:/cb`.
  const scheme = url.protocol.slice(0, -1);
  return scheme ? { kind: "app", scheme } : null;
}

/** Reads `redirect_uri` from the consent page's signed query string. */
export function redirectDestinationFromQuery(search: string): RedirectDestination | null {
  return describeRedirectDestination(new URLSearchParams(search).get("redirect_uri"));
}
