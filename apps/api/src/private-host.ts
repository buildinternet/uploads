/**
 * Literal-form private/loopback/link-local host checks.
 *
 * DNS-rebinding-grade resolution is out of scope — Cloudflare's edge is not
 * routed to our RFC 1918 space, so the risk is "don't hand an agent a pivot
 * into a private hostname they typed," not a full SSRF hardening pass.
 */

/** Parses a dotted-quad IPv4 literal into its four octets, or `null`. */
function parseIpv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (octets.some((o) => o > 255)) return null;
  return octets as [number, number, number, number];
}

/**
 * Parses the trailing 32 bits of an IPv4-mapped IPv6 address (the part after
 * `::ffff:`) into dotted-quad octets. Accepts both forms the wire can carry:
 * the dotted form (`127.0.0.1`) and the hex-group form (`7f00:1`) that `URL`
 * normalizes dotted IPv4-mapped addresses into (verified:
 * `new URL("http://[::ffff:127.0.0.1]/").hostname` → `[::ffff:7f00:1]`).
 */
function parseIpv4MappedTail(tail: string): [number, number, number, number] | null {
  const dotted = parseIpv4(tail);
  if (dotted) return dotted;

  const hexParts = tail.split(":");
  if (hexParts.length !== 2 || hexParts.some((p) => !/^[0-9a-f]{1,4}$/.test(p))) return null;
  const hi = Number.parseInt(hexParts[0], 16);
  const lo = Number.parseInt(hexParts[1], 16);
  const value = (hi << 16) | lo;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** True for the private/loopback/link-local IPv4 ranges we block. */
function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0) return true; // 0.0.0.0/8 ("this network" / unspecified)
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (incl. cloud metadata)
  return false;
}

/**
 * True for hostnames that resolve (by literal form, not DNS) to a private,
 * loopback, or link-local network, plus the conventional `.internal`/`.local`
 * TLDs.
 */
export function isPrivateRenderTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".internal") || host.endsWith(".local")) return true;
  if (host === "::1") return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  // IPv4-mapped IPv6 (::ffff:a.b.c.d or its ::ffff:xxxx:yyyy hex-normalized
  // form) — decode the trailing 32 bits and re-run the IPv4 range checks.
  const mapped = /^::ffff:(.+)$/.exec(host);
  if (mapped) {
    const tail = parseIpv4MappedTail(mapped[1]);
    if (tail) return isPrivateIpv4(tail);
  }

  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true; // fe80::/10 link-local

  return false;
}
