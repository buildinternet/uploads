/**
 * Guard for `/internal/*`. Only `apps/api` should reach these routes, over
 * the `AUTH` service binding.
 *
 * The caller sends `x-uploads-internal-key`, and this compares it to
 * `AUTH_INTERNAL_KEY`. Both sides are SHA-256'd first, then compared with a
 * fixed-length XOR, so a length mismatch cannot skip the compare. An unset
 * secret always fails. The middleware turns that into a 404 so a public
 * probe does not learn that the route exists.
 *
 * `crypto.subtle.timingSafeEqual` is Workers-only. This check also runs under
 * plain-Node vitest, same as the digest-token HMAC compare.
 *
 * The previous check trusted `x-uploads-internal: 1` plus a missing
 * `cf-connecting-ip`. That fails open if an edge request arrives without the
 * IP header. This gate ignores both. The API still sends the old header so a
 * deploy of the API that lands first keeps working against an auth worker
 * that has not picked up this check yet.
 */
export async function isInternalRequest(
  req: Request,
  secret: string | undefined,
): Promise<boolean> {
  const configured = secret ?? "";
  const provided = req.headers.get("x-uploads-internal-key") ?? "";
  const providedHash = await sha256Bytes(provided);
  const expectedHash =
    configured.length > 0 ? await sha256Bytes(configured) : providedHash.map((byte) => byte ^ 0xff);
  return (
    configured.length > 0 && provided.length > 0 && timingSafeEqual(providedHash, expectedHash)
  );
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}
