/**
 * Literal-form private/loopback/link-local host checks. Mirrors the API's
 * `isPrivateRenderTarget` so CLI `--via remote` and `put --url` reject the
 * same targets the render/fetch endpoints would.
 *
 * Accepts a bare hostname or an IPv6 literal with its brackets still attached
 * (as returned by `new URL(...).hostname`, e.g. `"[::1]"`).
 */

/** IPv4 loopback/private/link-local ranges. */
const PRIVATE_IPV4_RE =
  /^(127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

/** Hostname forms treated as local/private regardless of DNS resolution. */
const PRIVATE_HOSTNAME_RE = /^((.+\.)?localhost|.+\.local|.+\.internal)$/i;

/** IPv6 unique local addresses, fc00::/7 (RFC 4193). */
const IPV6_ULA_RE = /^f[cd][0-9a-f]{2}:/i;

/** IPv6 link-local addresses, fe80::/10. */
const IPV6_LINK_LOCAL_RE = /^fe[89ab][0-9a-f]:/i;

function isPrivateIPv4(host: string): boolean {
  return PRIVATE_IPV4_RE.test(host);
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = /^\[.+\]$/.test(hostname) ? hostname.slice(1, -1) : hostname;

  if (isPrivateIPv4(host)) return true;
  if (PRIVATE_HOSTNAME_RE.test(host)) return true;
  if (host === "::1" || host === "::") return true;
  if (IPV6_ULA_RE.test(host)) return true;
  if (IPV6_LINK_LOCAL_RE.test(host)) return true;

  // IPv4-mapped IPv6, e.g. "::ffff:10.0.0.1" or "::ffff:a00:1" — private iff
  // the mapped IPv4 quad is private.
  const mapped = /^::ffff:(.+)$/i.exec(host);
  if (mapped) {
    const rest = mapped[1]!;
    if (isPrivateIPv4(rest)) return true;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(rest);
    if (hex) {
      const hi = Number.parseInt(hex[1]!, 16);
      const lo = Number.parseInt(hex[2]!, 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >> 8) & 0xff;
      const d = lo & 0xff;
      if (isPrivateIPv4(`${a}.${b}.${c}.${d}`)) return true;
    }
  }

  return false;
}
