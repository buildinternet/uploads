/**
 * Headers for an AUTH service-binding call to `/internal/*`.
 *
 * `x-uploads-internal-key` is the shared `AUTH_INTERNAL_KEY`. The auth worker
 * rejects the call when the values differ, or when either side is empty.
 * `x-uploads-internal: 1` is the previous signal. Current auth ignores it.
 * An API deploy that lands first still satisfies an auth worker that has not
 * picked up the secret check yet.
 */
export function authInternalHeaders(
  env: { AUTH_INTERNAL_KEY?: string },
  extra?: HeadersInit,
): Headers {
  const headers = new Headers(extra);
  headers.set("x-uploads-internal", "1");
  const key = env.AUTH_INTERNAL_KEY;
  if (typeof key === "string" && key.length > 0) {
    headers.set("x-uploads-internal-key", key);
  }
  return headers;
}
